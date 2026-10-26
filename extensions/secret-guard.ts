/**
 * Secret guard: keeps the agent out of protected folders, and redacts secret
 * values from .env files.
 *
 * Settings, under "secretGuard" in settings.json. A project's settings can add
 * to the global lists but not remove from them.
 *   folders      Folder names whose contents are off limits. Default ["vault"].
 *   redactFiles  File-name globs whose secret values are redacted.
 *                Default [".env", ".env.*", "*.env", ".envrc"].
 *   redactKeys   Name parts that mark a value as secret. Default PASSWORD,
 *                PASSWD, PASSPHRASE, SECRET, TOKEN, KEY, APIKEY, CREDENTIAL,
 *                CREDENTIALS, PRIVATE. A part of 5 or more letters also matches
 *                inside a longer name, such as DBPASSWORD.
 *
 * Protected folders, matched by name in any case, with symlinks resolved. A path
 * into one (vault/x) counts wherever it appears; the folder itself (vault)
 * counts only where it exists, so a word such as "vault" is fine elsewhere:
 * - read, ls, edit, write, grep and find on a path inside one are blocked;
 * - a bash command that names such a path is blocked, and so is any other
 *   tool argument that is one, such as an MCP tool opening file:///…/vault/x;
 * - lines naming one are removed from grep, find and bash output, and so are
 *   whole git diff sections of files inside one, though not pi's own lines
 *   after the output. pi's file of a long bash command's full output that holds
 *   such a section is refused to bash and grep, even named in an interpreter's
 *   code; read, which knows where its offset starts, shows it;
 * - subagents load this guard too, through pi-subagents' required child
 *   extensions.
 *
 * Secret files: the values of secret-looking names, passwords inside URLs and
 * private-key blocks become [REDACTED] in read, grep and bash output, in a
 * secret file's git diff sections, and in the output of env, printenv, export
 * and declare. pi's file of a long bash
 * output, which the model is told to read, is redacted the same way in what
 * read, grep and a bash command that names it return. Writing [REDACTED] into a
 * secret file is blocked, so a redacted copy can't replace the real one.
 *
 * This guards against accidents, not a determined agent: a glob that never
 * names a protected folder can still print the files inside it.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { expandHome, realOrSame } from "../src/paths.ts";
import {
  isBashLog,
  isOmission,
  linesOf,
  type Placement,
  patchResult,
  placeOf,
  toolPath,
  WHOLE,
} from "../src/pi-output.ts";
import { layered, readGlobal } from "../src/settings.ts";
import { base, commandsOf, pathsOf } from "../src/shell.ts";
import { joinSubagents } from "../src/subagents.ts";

export const MARK = "[REDACTED]";

export interface Config {
  folders: string[];
  redactFiles: string[];
  redactKeys: string[];
}

export const DEFAULTS: Config = {
  folders: ["vault"],
  redactFiles: [".env", ".env.*", "*.env", ".envrc"],
  redactKeys: [
    "PASSWORD",
    "PASSWD",
    "PASSPHRASE",
    "SECRET",
    "TOKEN",
    "KEY",
    "APIKEY",
    "CREDENTIAL",
    "CREDENTIALS",
    "PRIVATE",
  ],
};

const FILE_TOOLS = new Set(["read", "ls", "edit", "write", "grep", "find"]);
// Tools whose arguments are prose for another agent, not paths it opens.
const PROSE_TOOLS = new Set(["subagent", "subagent_supervisor", "intercom", "contact_supervisor", "loop"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * The global settings decide each list; a project's settings can only add to
 * it. A global list that isn't all strings counts as the default, not as empty.
 */
export function loadConfig(merged: unknown, global: unknown): Config {
  const settings = layered(merged, global);
  const pick = (k: keyof Config) => settings.projectAdds(k, DEFAULTS[k], strings);
  return { folders: pick("folders"), redactFiles: pick("redactFiles"), redactKeys: pick("redactKeys") };
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The first segment of a path that names a protected folder the path goes on
 * into or, when `existing` is given, one that ends the path and that `existing`
 * confirms.
 */
function folderIn(path: string, folders: string[], existing?: (dir: string) => boolean): string | undefined {
  const names = new Set(folders.map((f) => f.toLowerCase()));
  const parts = path.split(/[\\/]/);
  for (let i = 0; i < parts.length; i++) {
    if (!names.has(parts[i].toLowerCase())) continue;
    if (i < parts.length - 1 || existing?.(parts.slice(0, i + 1).join("/"))) return parts[i];
  }
  return undefined;
}

/**
 * The protected folder a path names, judged on the path and on where its
 * symlinks lead. A path into one, such as vault/x, counts by name alone, since
 * it may be relative to some other folder: a repository's root, a tool's path
 * argument. The folder itself, such as vault or x/vault, counts only if it
 * exists in one of `bases`, so a word such as "vault" in a command is fine
 * wherever there is no vault folder.
 */
export function protectedPath(
  raw: string,
  cwd: string,
  folders: string[],
  bases = [cwd],
): string | undefined {
  // Only file:// URLs name local files; https://host/vault/x does not.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^file:\/\//i.test(raw)) return undefined;
  let p = raw.replace(/^file:\/\//i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not URL-encoded.
  }
  for (const dir of bases) {
    const abs = resolve(dir, expandHome(p));
    const hit = folderIn(abs, folders, isDir) ?? folderIn(realOrSame(abs), folders, isDir);
    if (hit) return hit;
  }
  return undefined;
}

/** The folders a bash line may work in: the session's, and those it moves to. */
const workDirs = (cwd: string, dirs: string[]) => [cwd, ...dirs.map((dir) => resolve(cwd, expandHome(dir)))];

/**
 * The protected folder a bash command names, if any. Each word is resolved
 * against the working directory, so a session inside a protected folder has
 * every command refused. `paths` is the command's, when the caller has them.
 */
export function bashHit(
  command: string,
  cwd: string,
  folders: string[],
  paths = pathsOf(command),
): string | undefined {
  const bases = workDirs(cwd, paths.dirs);
  for (const part of paths.parts) {
    const hit = protectedPath(part, cwd, folders, bases);
    if (hit) return hit;
  }
  return undefined;
}

/** The protected folder named by any path-like string in another tool's arguments. */
function argHit(value: unknown, cwd: string, folders: string[]): string | undefined {
  if (typeof value === "string") {
    for (const word of value.split(/\s+/)) {
      if (!word.includes("/") && !word.startsWith("~")) continue;
      const hit = protectedPath(word.replace(/^['"(]+|['"),]+$/g, ""), cwd, folders);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const hit = argHit(v, cwd, folders);
      if (hit) return hit;
    }
  }
  return undefined;
}

const globs = new Map<string, RegExp>();
function globRe(glob: string): RegExp {
  let re = globs.get(glob);
  if (!re) {
    const body = [...glob].map((ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : escapeRe(ch))).join("");
    re = new RegExp(`^${body}$`, "i");
    globs.set(glob, re);
  }
  return re;
}

export function isSecretFile(p: string, cfg: Config): boolean {
  const name = base(p);
  return cfg.redactFiles.some((g) => globRe(g).test(name));
}

export function secretName(name: string, keys: string[]): boolean {
  const upper = name.toUpperCase();
  const parts = upper.split(/[^A-Z0-9]+/);
  return keys.some((k) => {
    const key = k.toUpperCase();
    return parts.includes(key) || (key.length >= 5 && upper.includes(key));
  });
}

/** Whether a shell word names a secret file; a glob, if it matches one in its folder. */
function namesSecretFile(word: string, cwd: string, cfg: Config): boolean {
  const name = base(word);
  if (!/[*?]/.test(name)) return isSecretFile(word, cfg);
  const re = globRe(name);
  try {
    const dir = resolve(cwd, expandHome(word.slice(0, word.length - name.length) || "."));
    // As in the shell, * and ? don't match a leading dot.
    return readdirSync(dir).some(
      (f) => re.test(f) && (!f.startsWith(".") || name.startsWith(".")) && isSecretFile(f, cfg),
    );
  } catch {
    return false;
  }
}

// Line numbers (grep -n, cat -n, or both, as in pi's log of one), a diff's hunk
// header, whose context git takes from a line before the hunk, and markers (+,
// -, <, > or diff -c's !; two in a merge's), an optional export or declare, then NAME=value
// or NAME: value. The space after the hunk's first @@ keeps a line of @ linear.
// [^\n] where . would do, since . skips \r and the Unicode line separators.
const ASSIGN =
  /^(\s*(?:\d+[:\t-]\s*)*(?:@@+ [^@]*@@+ ?)?(?:[-+<>!]+\s*)?(?:(?:export|declare|typeset)\s+(?:-[A-Za-z]+\s+)*)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*|\s*:\s+)([^\n]*)$/;
// scheme://user:password@, where the user may be empty and the password may hold a /.
const URL_USER = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]*:/gi;
const URL_PASSWORD = /[^\s@]*/y;
const KEY_BLOCK = "[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?";
const PEM_BEGIN = new RegExp(`-----BEGIN ${KEY_BLOCK}-----`);
const PEM_END = new RegExp(`-----END ${KEY_BLOCK}-----`);
// The rest of the line after a block opens, up to a CRLF line's \r.
const PEM_REST = new RegExp(`["']?-----BEGIN ${KEY_BLOCK}-----[^\\n]*?(?=\\r?$)`);
const PEM_INLINE = new RegExp(
  `(["']?)-----BEGIN ${KEY_BLOCK}-----[\\s\\S]*?-----END ${KEY_BLOCK}-----\\1`,
  "g",
);

/**
 * Redacts the passwords inside URLs, of any length. A password runs to the next
 * @; one that reaches a space or the end of the line first is none, and neither
 * is any URL that starts inside it, so the scan skips past it. That keeps a long
 * line of URLs with ports, and no @, linear.
 */
function redactUrls(line: string): string {
  let out = "";
  let kept = 0;
  URL_USER.lastIndex = 0;
  while (URL_USER.exec(line)) {
    const from = URL_USER.lastIndex;
    URL_PASSWORD.lastIndex = from;
    URL_PASSWORD.exec(line);
    const to = URL_PASSWORD.lastIndex;
    if (line[to] === "@" && to > from) {
      out += line.slice(kept, from) + MARK;
      kept = to;
    }
    URL_USER.lastIndex = to;
  }
  return out + line.slice(kept);
}

export function redactLine(line: string, keys: string[]): string {
  // A CRLF file's lines end in \r, which is kept out of the match and put back after.
  const cr = line.endsWith("\r") ? "\r" : "";
  const out = redactUrls(line.slice(0, line.length - cr.length));
  const m = ASSIGN.exec(out);
  if (m?.[4].trim() && secretName(m[2], keys)) return `${m[1]}${m[2]}${m[3]}${MARK}${cr}`;
  return out + cr;
}

/**
 * Redacts an output line that comes from a secret file or pi's file of a long
 * bash output. grep, rg and pi's grep tool print one as path:text,
 * path:line:text or path-line-text; the path is the first prefix, cut at a : or
 * -, that names one.
 */
function redactMatch(line: string, cfg: Config, depth = 0): string {
  const end = Math.min(line.length, 1024);
  for (let i = 1; i < end; i++) {
    if (line[i] !== ":" && line[i] !== "-") continue;
    const path = line.slice(0, i);
    if (isSecretFile(path, cfg)) return line.slice(0, i + 1) + redactLine(line.slice(i + 1), cfg.redactKeys);
    if (isBashLog(path)) {
      // The log's line may be an earlier grep's, under its own prefix, so
      // past the line number it is looked at again, a few levels deep.
      const rest = line.slice(i + 1);
      const number = /^\d+[:-] ?/.exec(rest)?.[0] ?? "";
      const inner = rest.slice(number.length);
      const saved = depth < 8 ? redactMatch(inner, cfg, depth + 1) : inner;
      return line.slice(0, i + 1) + number + redactLine(saved, cfg.redactKeys);
    }
  }
  return line;
}

const DIFF_HEADER = /^diff --(?:git|cc|combined) (.*)$/;
// A commit line, full or --oneline, whose hash is followed by a space: no
// line of a diff starts so, nor can a key's base64 line, though --word-diff
// shows a line with no + or - in front.
const COMMIT_LINE = /^(?:commit [0-9a-f]{7,40}\b|[0-9a-f]{7,40} )/;
// A diff's hunk header, without the context git adds after it.
const HUNK = /^@@+ [^@]*@@+/;
// What splits an output line into the words that may be paths.
const WORDS = /[\s'"=:(),[\]]+/;

/** The paths a diff header names, if the line is one. git quotes a path with a non-ASCII character. */
const headerPaths = (line: string) =>
  DIFF_HEADER.exec(line)?.[1]
    .split(/\s+/)
    .map((w) => w.replace(/^"|"$/g, "")) ?? [];

/** Whether a line opens the git diff section of a file in a protected folder. */
const opensSection = (line: string, folders: string[]) =>
  headerPaths(line).some((w) => folderIn(w, folders) !== undefined);

/** The git diff section output is in: a protected file's, whose lines are dropped, a secret file's, whose lines are redacted, or neither. */
type Section = "none" | "protected" | "secret";

/** Where output is: in which diff section, and whether inside a private-key block. */
type State = { section: Section; inKey: boolean };

const START: State = { section: "none", inKey: false };

/**
 * What a line is: a diff header; a commit line that ends a section; a hunk
 * header; a line inside a private-key block, END included; a line that opens
 * one; an END with no BEGIN, from a block whose start isn't shown; or other.
 */
type Role = "header" | "commit" | "hunk" | "key" | "begin" | "end" | "text";

/**
 * A line's role, and the state after it; `kind` says which section a diff
 * header opens. A header, a commit line that ends a section and a hunk header
 * each end a key block, since none can be part of one, and a hunk may start
 * inside one unseen. Outside a section, a line can start like a commit line
 * and still hold a key's line, as git blame prints each line of a file after
 * its commit, so it ends nothing.
 */
function step(s: State, line: string, kind: (header: string) => Section): [Role, State] {
  if (DIFF_HEADER.test(line)) return ["header", { section: kind(line), inKey: false }];
  if (s.section !== "none" && COMMIT_LINE.test(line)) return ["commit", START];
  if (HUNK.test(line)) return ["hunk", { section: s.section, inKey: false }];
  if (s.inKey) return ["key", { section: s.section, inKey: !PEM_END.test(line) }];
  const begins = PEM_BEGIN.test(line);
  const ends = PEM_END.test(line);
  if (begins && !ends) return ["begin", { section: s.section, inKey: true }];
  return [ends && !begins ? "end" : "text", s];
}

// Lines past which a private-key block may have opened unseen.
const RESTARTS = new Set<Role>(["header", "commit", "hunk", "end"]);

/**
 * The state after lines, from the start of an output, how many lines there
 * are, and, of those from index `from` on, the first past which a block may
 * have opened unseen: its role, and the section it is in.
 */
function stateAfter(lines: Iterable<string>, kind: (header: string) => Section, from = 0) {
  let state = START;
  let count = 0;
  let restart: { role: Role; section: Section } | undefined;
  for (const line of lines) {
    const [role, next] = step(state, line, kind);
    if (!restart && count >= from && RESTARTS.has(role)) restart = { role, section: next.section };
    state = next;
    count++;
  }
  return { state, count, restart };
}

/**
 * How output is filtered. `protect` removes lines that name a path into a
 * protected folder, and protected files' diff sections. Secret files' diff
 * sections, and grep lines from secret files, are always redacted; `redact`
 * says what else is: "all" every line, as a secret file's, and "values" every
 * line whole, as printenv NAME prints a bare value.
 */
export type Filter = { protect: boolean; redact: "matches" | "all" | "values" };

// The longest whole line that a part of it is judged by, as long as codemode's
// whole copy. A part of a longer one is the mark, which keeps what judging a
// part costs bounded, however long its line.
const LONGEST = 1024 * 1024;

/**
 * Filters a copy of a tool's output in one pass, line by line, from the state
 * where the copy starts in the whole output, and where it resumes after
 * codemode's omission marker. A private-key block is dropped but its BEGIN
 * line, which becomes the mark. An END with no BEGIN drops the lines back to
 * the last header, commit line, hunk header or END, past which a block may have
 * opened unseen. In a secret file's diff section, a
 * hunk header loses the context git adds, which may be a line inside a key. A
 * line that is part of a longer one is judged by that line: dropped if it would
 * be, kept if it would be unchanged, and otherwise the mark, as it is when that
 * line is too long to judge.
 */
export function filterOutput(text: string, cfg: Config, how: Filter, place: Placement = WHOLE): string {
  const folders = how.protect ? cfg.folders : [];
  const kind = (header: string): Section => {
    if (opensSection(header, folders)) return "protected";
    return headerPaths(header).some((w) => isSecretFile(w, cfg)) ? "secret" : "none";
  };
  const names = (line: string) => line.split(WORDS).some((w) => folderIn(w, folders) !== undefined);
  const out: (string | undefined)[] = [];
  const start = stateAfter(place.before, kind);
  let state = start.state;
  let from = 0;
  let removed = 0;
  // Where in `out` pi's own lines are, which no END drops.
  const pis = new Set<number>();
  const dropBack = () => {
    for (let k = from; k < out.length; k++) if (!pis.has(k)) out[k] = undefined;
  };
  const lines = text.split("\n");
  const omission = place.omission && isOmission(lines[place.omission.at] ?? "") ? place.omission : undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // pi's marker, and the blank line on each side of it, are no part of the output.
    if (omission && Math.abs(i - omission.at) <= 1) {
      pis.add(out.length);
      out.push(line);
      if (i === omission.at) {
        // The part left out starts at the line the head ends on, which may
        // show only its start. An END with no BEGIN first there drops the head
        // back, where an END drops back at all, and after a restart there an
        // END drops back no further.
        const resumed = stateAfter(omission.before, kind, start.count + omission.at - 2);
        state = resumed.state;
        const r = resumed.restart;
        if (r?.role === "end" && (how.redact === "all" || r.section === "secret")) dropBack();
        if (r) from = out.length;
      }
      continue;
    }
    const whole = place.parts.get(i);
    const full = whole?.includes(line) ? whole : line;
    const [role, next] = step(state, full, kind);
    state = next;
    const long = full !== line && full.length > LONGEST;
    // Where a key's lines are dropped, an END with no BEGIN drops the lines
    // back to where its block may have opened, even one that is itself
    // removed for naming a protected path.
    if (role === "end" && (how.redact === "all" || state.section === "secret")) dropBack();
    let fate: string | undefined;
    if (state.section === "protected" || (!long && names(full))) removed++;
    else if (how.redact !== "all" && state.section !== "secret") fate = long ? MARK : redactMatch(full, cfg);
    else if (role === "hunk" && state.section === "secret") fate = HUNK.exec(full)?.[0];
    else if (role === "key" || role === "end") fate = undefined;
    else if (long) fate = MARK;
    else {
      const m = redactMatch(full, cfg);
      fate = redactLine(m.replace(role === "begin" ? PEM_REST : PEM_INLINE, MARK), cfg.redactKeys);
    }
    if (fate !== undefined && how.redact === "values" && /\S/.test(fate)) fate = MARK;
    if (fate !== undefined && full !== line) fate = fate === full ? line : MARK;
    out.push(fate);
    if (RESTARTS.has(role)) from = out.length;
  }
  const kept = out.filter((line) => line !== undefined);
  if (removed) kept.push(`[secret-guard: removed ${removed} line(s) from protected folders]`);
  return kept.join("\n");
}

/**
 * What a bash command prints that must be redacted throughout: "values" for
 * printenv NAME with a secret NAME, which prints the bare value; "all" when it
 * lists the environment (env, printenv, export, declare) or reads a secret
 * file.
 */
function printsSecrets(command: string, cwd: string, cfg: Config): "values" | "all" | undefined {
  let found: "all" | undefined;
  for (const { words, argv, name, wrappers, redirects } of commandsOf(command)) {
    const args = argv.slice(1);
    if (name === "printenv" && args.some((a) => secretName(a, cfg.redactKeys))) return "values";
    const lists = (!argv.length && wrappers.includes("env")) || name === "printenv";
    // set lists variables only with no arguments; export, declare and typeset
    // with options alone; declare -p and typeset -p print the ones they name.
    const declares =
      name === "set"
        ? !args.length
        : (["export", "declare", "typeset"].includes(name) && args.every((a) => a.startsWith("-"))) ||
          (["declare", "typeset"].includes(name) && args.some((a) => /^-[A-Za-z]*p/.test(a)));
    // git show rev:path and --opt=path name the file after the : or =.
    const named = (t: string) => [t, ...t.split(/[:=]/).slice(1)].some((p) => namesSecretFile(p, cwd, cfg));
    if (lists || declares || [...words, ...redirects].some(named)) {
      found = "all";
    }
  }
  // pi's file of a long output holds whatever a command printed, so a command
  // that names one is redacted. Only a command with its name in is expanded.
  if (command.includes("pi-bash-") && pathsOf(command).parts.some(isBashLog)) found = "all";
  return found;
}

/** Whether a bash command would write the redaction mark into a secret file. */
function writesMark(command: string, cfg: Config): boolean {
  if (!command.includes(MARK)) return false;
  return commandsOf(command).some((c) => [...c.words, ...c.redirects].some((t) => isSecretFile(t, cfg)));
}

/**
 * Whether a path, from any of `bases`, is pi's file of a bash command's full
 * output, holding a protected file's diff section. Only read, whose offset says
 * where it starts, can show part of one safely.
 */
function guardedLog(p: string, bases: string[], folders: string[]): boolean {
  if (!isBashLog(p)) return false;
  const holds = (path: string, cwd: string) => {
    for (const line of linesOf(path, cwd)) if (opensSection(line, folders)) return true;
    return false;
  };
  // From where the command works, and by its name where pi writes its files.
  return bases.some((b) => holds(p, b)) || holds(base(p), tmpdir());
}

export default function (pi: ExtensionAPI) {
  let cfg: Config = DEFAULTS;
  let subagents: { leave(): void } | undefined;

  const refuse = (folder: string) => ({
    block: true,
    reason: `secret-guard: ${folder}/ is a protected folder. Its files must not be read, listed or changed, by any tool or command. Don't look for another way in; ask the user if you need something from it.`,
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    cfg = loadConfig((pi.getSettings() as Record<string, unknown>).secretGuard, readGlobal("secretGuard"));
    subagents?.leave();
    subagents = undefined;
    try {
      const path = realpathSync(fileURLToPath(import.meta.url));
      subagents = await joinSubagents(ctx.sessionManager.getSessionId(), "secret-guard", path);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`secret-guard: subagents will not load this guard: ${why}`, "warning");
    }
  });

  pi.on("session_shutdown", () => {
    subagents?.leave();
    subagents = undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    const name = event.toolName;
    const path = toolPath(input) ?? ".";
    const command = String(input.command ?? "");
    if (
      (name === "write" || name === "edit") &&
      isSecretFile(path, cfg) &&
      JSON.stringify(input).includes(MARK)
    ) {
      return {
        block: true,
        reason: `secret-guard: ${MARK} stands for a secret this guard hid from you. Writing it into ${base(path)} would replace the real value. Ask the user to make this change.`,
      };
    }
    if (name === "bash" && writesMark(command, cfg)) {
      return {
        block: true,
        reason: `secret-guard: ${MARK} stands for a secret this guard hid from you. Writing it into a secret file would replace the real value. Ask the user to make this change.`,
      };
    }
    // A bash command's paths, parsed once for both checks below.
    const paths = name === "bash" ? pathsOf(command) : undefined;
    const named = name === "grep" ? [path] : (paths?.parts ?? []);
    const bases = workDirs(ctx.cwd, paths?.dirs ?? []);
    if (named.some((p) => guardedLog(p, bases, cfg.folders))) {
      return {
        block: true,
        reason:
          "secret-guard: this file of a command's full output holds lines from a protected folder. Read it with the read tool, which leaves them out.",
      };
    }
    let hit: string | undefined;
    if (FILE_TOOLS.has(name)) hit = protectedPath(path, ctx.cwd, cfg.folders);
    else if (name === "bash") hit = bashHit(command, ctx.cwd, cfg.folders, paths);
    else if (!PROSE_TOOLS.has(name)) hit = argHit(input, ctx.cwd, cfg.folders);
    return hit ? refuse(hit) : undefined;
  });

  const filterResult = (event: ToolResultEvent, cwd: string) => {
    const path = toolPath(event.input);
    let how: Filter | undefined;
    if (event.toolName === "read" && path !== undefined) {
      // pi's file of a long bash output is filtered as the output was, and
      // redacted, since the command may have printed secrets. It comes first,
      // so a project's redactFiles can't skip the filtering.
      if (isBashLog(path)) how = { protect: true, redact: "all" };
      else if (isSecretFile(path, cfg)) how = { protect: false, redact: "all" };
    } else if (event.toolName === "grep" || event.toolName === "find") {
      how = { protect: true, redact: "matches" };
    } else if (event.toolName === "bash") {
      const prints = printsSecrets(String(event.input.command ?? ""), cwd, cfg);
      how = { protect: true, redact: prints ?? "matches" };
    }
    if (!how) return undefined;
    const filter = how;
    // grep and find output is never cut off from a file pi keeps.
    const place = event.toolName === "read" || event.toolName === "bash" ? placeOf(event, cwd) : undefined;
    const placed = (at: Placement | undefined) => (t: string) => filterOutput(t, cfg, filter, at);
    return patchResult(event, placed(place?.text), placed(place?.structured));
  };

  pi.on("tool_result", (event, ctx) => {
    try {
      return filterResult(event, ctx.cwd);
    } catch (err) {
      // pi passes on the output unfiltered when a handler throws, so it is
      // withheld instead, codemode's copy too, which pi drops with new text.
      const why = err instanceof Error ? ((err as { code?: string }).code ?? err.name) : typeof err;
      const text = `[secret-guard: withheld this output, which it could not filter (${why})]`;
      return { content: [{ type: "text" as const, text }] };
    }
  });
}
