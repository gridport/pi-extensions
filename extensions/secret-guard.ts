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
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expandHome, realOrSame } from "../src/paths.ts";
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
    if (BASH_LOG.test(base(path))) {
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

// How pi cuts off long bash output. Its file of the full output, which the model is told to read:
const BASH_LOG = /^pi-bash-[0-9a-f]+\.log$/;
// its notice under the tail it shows, saying where the tail starts and naming that file:
const NOTICE =
  /^\[Showing (?:lines (\d+)-\d+ of \d+(?: \([^)\n]*\))?|last .+? of line (\d+) \(line is [^)\n]*\))\. Full output: (.+)\]$/;
// and where its copy for codemode leaves out the middle.
const OMISSION = /^\[\.\.\. \d+ bytes omitted \.\.\.\]$/;
// pi's other lines after a tool's output: bash's exit status, and read's hints for reading on.
const STATUS =
  /^(?:Command (?:exited with code \d+|aborted|timed out after \d+ seconds|terminated without an exit code)|\[(?:Showing lines \d+-\d+ of \d+(?: \([^)\n]*\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\])$/;

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
    if (OMISSION.test(line)) {
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
export function redactDiffs(text: string, cfg: Config, cut: Cut = {}): string {
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
  if (command.includes("pi-bash-") && pathsOf(command).parts.some((p) => BASH_LOG.test(base(p))))
    found = "assignments";
  return found;
}

/** Whether a bash command would write the redaction mark into a secret file. */
function writesMark(command: string, cfg: Config): boolean {
  if (!command.includes(MARK)) return false;
  return commandsOf(command).some((c) => [...c.words, ...c.redirects].some((t) => isSecretFile(t, cfg)));
}

const readLines = (path: string) => {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
};

/** The path a file tool's input names, without the @ pi drops from it, as its @ file mentions carry one. */
const toolPath = (input: Record<string, unknown>) =>
  typeof input.path === "string" ? input.path.replace(/^@/, "") : undefined;

/** pi's notice in a line, if it names pi's own file: how many lines it left out of the head, and that file. */
function notice(line: string): { hidden: number; log: string } | undefined {
  const m = NOTICE.exec(line);
  return m && BASH_LOG.test(base(m[3])) ? { hidden: Number(m[1] ?? m[2]) - 1, log: m[3] } : undefined;
}

/**
 * A tool's text split into its output and the lines pi adds after it, each
 * after a blank line: bash's notice and exit status, read's hints for reading
 * on. They are pi's, whatever section the output ends in.
 */
function splitTrailer(text: string): [string, string] {
  let body = text;
  for (;;) {
    const cut = body.lastIndexOf("\n\n");
    const line = cut < 0 ? body : body.slice(cut + 2);
    if (!STATUS.test(line) && !notice(line)) return [body, text.slice(body.length)];
    body = cut < 0 ? "" : body.slice(0, cut);
  }
}

/** How many lines pi left out of the head of a bash command's output, and the file that holds them all. */
function bashCut(text: string, details: unknown): { hidden: number; log: string } | undefined {
  const d = details as {
    truncation?: { totalLines?: number; outputLines?: number };
    fullOutputPath?: unknown;
  };
  if (typeof d?.fullOutputPath === "string") {
    return {
      hidden: (d.truncation?.totalLines ?? 0) - (d.truncation?.outputLines ?? 0),
      log: d.fullOutputPath,
    };
  }
  // A command that timed out or was aborted ends in an error, whose result
  // keeps only the text, so pi's notice after the output says what was cut. It
  // comes after any the output's last lines look like.
  return splitTrailer(text)[1]
    .split("\n")
    .map(notice)
    .findLast((n) => n !== undefined);
}

/**
 * Where each copy of a tool's output that pi cut off resumes: `text`, what the
 * model is shown, and `structured`, codemode's copy. Judged from pi's file of
 * the full output: a bash command's tail may start inside a protected or secret
 * file's diff section, codemode's copy of output over 1 MB leaves out a middle
 * part that may open one, and a read of the file from an offset starts partway
 * through it.
 */
function resumes(
  event: {
    toolName: string;
    input: Record<string, unknown>;
    content: { type: string; text?: string }[];
    details?: unknown;
  },
  cwd: string,
  cfg: Config,
): { text: Cut; structured: Cut } {
  const opens = (line: string) => opensSection(line, cfg.folders);
  const opensSecret = (line: string) => opensSecretSection(line, cfg);
  // Where text resumes after the lines before it.
  const after = (before: string[]) => ({
    inSection: endsInSection(before, opens),
    inSecret: endsInSection(before, opensSecret),
  });
  if (event.toolName === "read") {
    const offset = typeof event.input.offset === "number" ? event.input.offset : 1;
    const before =
      offset > 1 ? readLines(resolve(cwd, toolPath(event.input) ?? "")).slice(0, offset - 1) : [];
    const cut = after(before);
    return { text: cut, structured: cut };
  }
  const cut = bashCut(event.content.map((c) => c.text ?? "").join("\n"), event.details);
  if (!cut) return { text: {}, structured: {} };
  const lines = readLines(cut.log);
  return {
    text: after(lines.slice(0, Math.max(0, cut.hidden))),
    structured: { afterOmission: lines.some(opens) },
  };
}

/**
 * Whether a path is pi's file of a bash command's full output, holding a
 * protected file's diff section. Only read, whose offset says where it starts,
 * can show part of one safely.
 */
const guardedLog = (p: string, cwd: string, folders: string[]) =>
  BASH_LOG.test(base(p)) &&
  readLines(resolve(cwd, expandHome(p))).some((line) => opensSection(line, folders));

const mapText = (content: { type: string; text?: string }[], f: (t: string) => string) =>
  content.map((c) => (c.type === "text" && typeof c.text === "string" ? { ...c, text: f(c.text) } : c));

const mapStrings = (v: unknown, f: (t: string) => string): unknown =>
  typeof v === "string"
    ? f(v)
    : Array.isArray(v)
      ? v.map((x) => mapStrings(x, f))
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]))
        : v;

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
    const input = event.input as Record<string, unknown>;
    const output = (cut: Cut) => (t: string) =>
      redactDiffs(redactMatches(dropProtected(t, cfg.folders, cut), cfg), cfg, cut);
    // What the model is shown ends in pi's own lines, which are left as they are.
    const shown = (g: (t: string) => string) => (t: string) => {
      const [body, trailer] = splitTrailer(t);
      return g(body) + trailer;
    };
    const path = toolPath(input);
    let f: ((t: string) => string) | undefined;
    // For structuredContent, when it differs from what the model is shown.
    let structuredF: ((t: string) => string) | undefined;
    if (event.toolName === "read" && path !== undefined) {
      // pi's file of a long bash output, filtered as the output was, and
      // redacted, since the command may have printed secrets. It comes first,
      // so a project's redactFiles can't skip the filtering.
      if (BASH_LOG.test(base(path))) {
        const cut = resumes({ ...event, input }, ctx.cwd, cfg).text;
        f = shown((t) => redactText(output(cut)(t), cfg.redactKeys));
      } else if (isSecretFile(path, cfg)) f = (t) => redactText(t, cfg.redactKeys);
    } else if (event.toolName === "grep" || event.toolName === "find") {
      f = output({});
    } else if (event.toolName === "bash") {
      const prints = printsSecrets(String(input.command ?? ""), ctx.cwd, cfg);
      const cut = resumes({ ...event, input }, ctx.cwd, cfg);
      const redact = (kept: string) => {
        if (prints === "values") return kept.replace(/^.*\S.*$/gm, MARK);
        return prints ? redactText(kept, cfg.redactKeys) : kept;
      };
      f = shown((t) => redact(output(cut.text)(t)));
      structuredF = (t) => redact(output(cut.structured)(t));
    }
    if (!f) return undefined;
    const before = event.content as { type: string; text?: string }[];
    const after = mapText(before, f);
    const changed = after.some((c, i) => c.text !== before[i].text);
    // Codemode scripts get structuredContent, such as bash's whole output, in place of the text.
    const structured =
      event.structuredContent === undefined
        ? undefined
        : mapStrings(event.structuredContent, structuredF ?? f);
    if (!changed && JSON.stringify(structured) === JSON.stringify(event.structuredContent)) return undefined;
    return {
      ...(changed ? { content: after as typeof event.content } : {}),
      ...(structured === undefined
        ? {}
        : { structuredContent: structured as typeof event.structuredContent }),
    };
  });
}
