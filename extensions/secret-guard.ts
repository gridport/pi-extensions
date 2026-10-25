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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expandHome, realOrSame } from "../src/paths.ts";
import {
  isBashLog,
  isOmission,
  type LeftOut,
  leftOut,
  linesOf,
  patchResult,
  toolPath,
} from "../src/pi-output.ts";
import { readGlobal } from "../src/settings.ts";
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

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;
}

/** The global settings decide each list; a project's settings can only add to it. */
export function loadConfig(merged: unknown, global: unknown): Config {
  const m = (merged ?? {}) as Record<string, unknown>;
  const g = (global ?? {}) as Record<string, unknown>;
  const pick = (k: keyof Config) => [
    ...new Set([...(strings(g[k]) ?? DEFAULTS[k]), ...(strings(m[k]) ?? [])]),
  ];
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
  // The folders the line may work in: the session's, and those it moves to.
  const bases = [cwd, ...paths.dirs.map((dir) => resolve(cwd, expandHome(dir)))];
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

/** Redacts a secret file's text, line by line, dropping the body of any private-key block. */
export function redactText(text: string, keys: string[]): string {
  const out: string[] = [];
  let inKey = false;
  for (const line of text.split("\n")) {
    if (inKey) {
      if (PEM_END.test(line)) inKey = false;
      continue;
    }
    if (PEM_BEGIN.test(line) && !PEM_END.test(line)) {
      inKey = true;
      out.push(redactLine(line.replace(PEM_REST, MARK), keys));
      continue;
    }
    out.push(redactLine(line.replace(PEM_INLINE, MARK), keys));
  }
  return out.join("\n");
}

/**
 * Redacts output lines that come from secret files or pi's file of a long bash
 * output. grep, rg and pi's grep tool print them as path:text, path:line:text
 * or path-line-text; the path is the first prefix, cut at a : or -, that names
 * one.
 */
export function redactMatches(text: string, cfg: Config): string {
  return text
    .split("\n")
    .map((line) => redactMatch(line, cfg))
    .join("\n");
}

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
// A commit line, full or --oneline, ends a section: no line of a diff starts with hex.
const COMMIT_LINE = /^(?:commit )?[0-9a-f]{7,40}\b/;

/** The paths a diff header names, if the line is one. git quotes a path with a non-ASCII character. */
const headerPaths = (line: string) =>
  DIFF_HEADER.exec(line)?.[1]
    .split(/\s+/)
    .map((w) => w.replace(/^"|"$/g, "")) ?? [];

/** Whether a line opens the git diff section of a file in a protected folder. */
const opensSection = (line: string, folders: string[]) =>
  headerPaths(line).some((w) => folderIn(w, folders) !== undefined);

/** Whether a line opens the git diff section of a secret file. */
const opensSecretSection = (line: string, cfg: Config) => headerPaths(line).some((w) => isSecretFile(w, cfg));

type Opens = (header: string) => boolean;

/** Whether the section state after a line is inside a diff section of the kind `opens` picks out. */
function nextSection(line: string, inSection: boolean, opens: Opens): boolean {
  if (DIFF_HEADER.test(line)) return opens(line);
  return COMMIT_LINE.test(line) ? false : inSection;
}

/** Whether lines end inside a diff section of the kind `opens` picks out. */
function endsInSection(lines: string[], opens: Opens): boolean {
  let inSection = false;
  for (const line of lines) inSection = nextSection(line, inSection, opens);
  return inSection;
}

/**
 * Where text pi cut off resumes: inSection when it starts inside a protected
 * diff section, inSecret inside a secret file's, afterOmission for the state
 * after an omission marker.
 */
type Cut = { inSection?: boolean; inSecret?: boolean; afterOmission?: boolean };

/**
 * Removes lines that name a path into a protected folder, and the whole git diff
 * section of a file inside one, whose lines name no path. For text pi cut off,
 * `cut` says where it resumes.
 */
export function dropProtected(text: string, folders: string[], cut: Cut = {}): string {
  if (!folders.length) return text;
  const inFolder = (word: string) => folderIn(word, folders) !== undefined;
  const opens = (line: string) => opensSection(line, folders);
  const lines = text.split("\n");
  const kept: string[] = [];
  let inSection = cut.inSection ?? false;
  let partial = false;
  for (const line of lines) {
    if (isOmission(line)) {
      kept.push(line);
      inSection = cut.afterOmission ?? inSection;
      partial = true;
      continue;
    }
    // The tail after an omission starts partway through a line, which neither opens nor ends a section.
    if (partial && line) partial = false;
    else inSection = nextSection(line, inSection, opens);
    if (!inSection && !line.split(/[\s'"=:(),[\]]+/).some(inFolder)) kept.push(line);
  }
  const dropped = lines.length - kept.length;
  if (!dropped) return text;
  return [...kept, `[secret-guard: removed ${dropped} line(s) from protected folders]`].join("\n");
}

/**
 * Redacts the git diff section of a secret file, which git diff and git log -p
 * print though the command names no secret file. redactLine reads a diff's
 * lines past their markers and hunk headers. For text pi cut off, `cut` says
 * where it resumes.
 */
function redactDiffs(text: string, cfg: Config, cut: Cut = {}): string {
  const opens = (line: string) => opensSecretSection(line, cfg);
  let inSecret = cut.inSecret ?? false;
  return text
    .split("\n")
    .map((line) => {
      inSecret = nextSection(line, inSecret, opens);
      return inSecret ? redactLine(line, cfg.redactKeys) : line;
    })
    .join("\n");
}

/**
 * What a bash command prints that must be redacted throughout: "values" for
 * printenv NAME with a secret NAME, which prints the bare value; "assignments"
 * when it lists the environment (env, printenv, export, declare) or reads a
 * secret file.
 */
function printsSecrets(command: string, cwd: string, cfg: Config): "values" | "assignments" | undefined {
  let found: "assignments" | undefined;
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
    if (lists || declares || [...words, ...redirects].some((t) => namesSecretFile(t, cwd, cfg))) {
      found = "assignments";
    }
  }
  // pi's file of a long output holds whatever a command printed, so a command
  // that names one is redacted. Only a command with its name in is expanded.
  if (command.includes("pi-bash-") && pathsOf(command).parts.some(isBashLog)) found = "assignments";
  return found;
}

/** Whether a bash command would write the redaction mark into a secret file. */
function writesMark(command: string, cfg: Config): boolean {
  if (!command.includes(MARK)) return false;
  return commandsOf(command).some((c) => [...c.words, ...c.redirects].some((t) => isSecretFile(t, cfg)));
}

/**
 * Where a copy of a tool's output that pi cut off resumes, from what pi left
 * out of it: a bash command's tail, or a read from an offset, may start inside
 * a protected or secret file's diff section, and the middle part codemode's
 * copy leaves out may open one.
 */
function cutOf({ head, middle }: LeftOut, cfg: Config): Cut {
  const opens = (line: string) => opensSection(line, cfg.folders);
  return {
    inSection: endsInSection(head, opens),
    inSecret: endsInSection(head, (line) => opensSecretSection(line, cfg)),
    afterOmission: middle?.some(opens),
  };
}

/**
 * Whether a path is pi's file of a bash command's full output, holding a
 * protected file's diff section. Only read, whose offset says where it starts,
 * can show part of one safely.
 */
const guardedLog = (p: string, cwd: string, folders: string[]) =>
  isBashLog(p) && linesOf(p, cwd).some((line) => opensSection(line, folders));

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
    if (named.some((p) => guardedLog(p, ctx.cwd, cfg.folders))) {
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

  pi.on("tool_result", (event, ctx) => {
    const output = (cut: Cut) => (t: string) =>
      redactDiffs(redactMatches(dropProtected(t, cfg.folders, cut), cfg), cfg, cut);
    const path = toolPath(event.input);
    let text: ((t: string) => string) | undefined;
    // For codemode's copy, when it differs from what the model is shown.
    let structured: ((t: string) => string) | undefined;
    if (event.toolName === "read" && path !== undefined) {
      // pi's file of a long bash output, filtered as the output was, and
      // redacted, since the command may have printed secrets. It comes first,
      // so a project's redactFiles can't skip the filtering.
      if (isBashLog(path)) {
        const cut = cutOf(leftOut(event, ctx.cwd).text, cfg);
        text = (t) => redactText(output(cut)(t), cfg.redactKeys);
      } else if (isSecretFile(path, cfg)) text = (t) => redactText(t, cfg.redactKeys);
    } else if (event.toolName === "grep" || event.toolName === "find") {
      text = output({});
    } else if (event.toolName === "bash") {
      const prints = printsSecrets(String(event.input.command ?? ""), ctx.cwd, cfg);
      const left = leftOut(event, ctx.cwd);
      const cut = { text: cutOf(left.text, cfg), structured: cutOf(left.structured, cfg) };
      const redact = (kept: string) => {
        if (prints === "values") return kept.replace(/^.*\S.*$/gm, MARK);
        return prints ? redactText(kept, cfg.redactKeys) : kept;
      };
      text = (t) => redact(output(cut.text)(t));
      structured = (t) => redact(output(cut.structured)(t));
    }
    return text && patchResult(event, text, structured);
  });
}
