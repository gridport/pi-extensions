/**
 * Command guard: asks before the agent runs a destructive shell command.
 *
 * Settings, under "commandGuard" in settings.json. A project's settings can add
 * checks but not remove any.
 *   builtins        Which built-in checks run. Default ["rm", "sudo", "find"]:
 *                     rm    a recursive rm (-r, -R, --recursive)
 *                     sudo  anything run through sudo or doas
 *                     find  find with -delete, or with -exec, -execdir or -ok rm
 *   rules           More commands to confirm, such as
 *                   { "command": "git reset", "args": ["--hard"], "reason": "discards uncommitted work" }.
 *                   A rule matches a command that starts with those words, in
 *                   order, and, when args are given, has one of them. A short
 *                   flag such as -f also matches inside a cluster such as -fd.
 *   allowFolders    Folder names, such as node_modules or dist, that a recursive
 *                   rm or find may delete, or delete inside, without asking,
 *                   below the session's folder. Default []. Global settings
 *                   only.
 *   timeoutSeconds  How long the question waits before it counts as a no.
 *                   Default 120.
 *
 * Commands are split as the shell would split them, so pipelines, && chains,
 * bash -c '…', eval, xargs, env and sudo are looked into, and so is what echo
 * or a here-document pipes into a shell, while text inside a
 * quoted argument or a here-document, such as a commit message, is not taken
 * for a command. A recursive rm or find whose targets all lie inside a temp
 * directory or an allowed folder runs without asking; the question says when a
 * target has a variable or a glob. Where nobody can be asked (print mode,
 * subagents), the command is refused. With pi-subagents installed, its
 * subagents load this guard too.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expandHome, realOrSame } from "../src/paths.ts";
import { layered, readGlobal } from "../src/settings.ts";
import { base, commandsOf, programOf } from "../src/shell.ts";
import { joinSubagents } from "../src/subagents.ts";

export interface Rule {
  command: string;
  args?: string[];
  reason?: string;
}

export interface Config {
  builtins: string[];
  rules: Rule[];
  allowFolders: string[];
  timeoutSeconds: number;
}

export const DEFAULTS: Config = {
  builtins: ["rm", "sudo", "find"],
  rules: [],
  allowFolders: [],
  timeoutSeconds: 120,
};
const BUILTINS = new Set(DEFAULTS.builtins);

function validRule(r: unknown): r is Rule {
  if (!r || typeof r !== "object") return false;
  const { command, args, reason } = r as Record<string, unknown>;
  return (
    typeof command === "string" &&
    command.trim() !== "" &&
    (args === undefined || (Array.isArray(args) && args.every((a) => typeof a === "string" && a !== ""))) &&
    (reason === undefined || typeof reason === "string")
  );
}

/**
 * The global settings decide; a project's settings can only add builtins and
 * rules. The timeout and the allowed folders, which let deletes run without
 * asking, come from the global settings alone.
 */
export function loadConfig(merged: unknown, global: unknown): { config: Config; problems: string[] } {
  const settings = layered(merged, global);
  const problems: string[] = [];
  const isList = (v: unknown): v is unknown[] => Array.isArray(v);
  const builtins = settings.projectAdds<unknown>("builtins", DEFAULTS.builtins, isList).filter((b) => {
    if (typeof b === "string" && BUILTINS.has(b)) return true;
    problems.push(`unknown builtin ${JSON.stringify(b)}`);
    return false;
  }) as string[];
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const r of settings.projectAdds("rules", [], isList)) {
    if (!validRule(r)) {
      problems.push(`invalid rule ${JSON.stringify(r)}`);
      continue;
    }
    const key = JSON.stringify(r);
    if (!seen.has(key)) rules.push(r);
    seen.add(key);
  }
  // Folder names only, so no entry can be a path such as / or ~.
  const folders = settings.globalOnly("allowFolders");
  const allowFolders = [...new Set(isList(folders) ? folders : [])].filter((f) => {
    if (typeof f === "string" && f !== "" && f !== "." && f !== ".." && !f.includes("/")) return true;
    problems.push(`invalid allowFolders entry ${JSON.stringify(f)}`);
    return false;
  }) as string[];
  const t = settings.globalOnly("timeoutSeconds");
  const timeoutSeconds = typeof t === "number" && t > 0 ? t : DEFAULTS.timeoutSeconds;
  if (t !== undefined && timeoutSeconds !== t) problems.push(`invalid timeoutSeconds ${JSON.stringify(t)}`);
  return { config: { builtins, rules, allowFolders, timeoutSeconds }, problems };
}

// Only the temp directories themselves: on macOS TMPDIR lies under
// /var/folders, and listing that would let `rm -rf $TMPDIR` through.
const TEMP_ROOTS = [
  ...new Set(
    [tmpdir(), process.env.TMPDIR, "/tmp", "/private/tmp"]
      .filter((p): p is string => !!p)
      .flatMap((p) => [p, realOrSame(p)])
      .map((p) => p.replace(/\/+$/, "")),
  ),
];

const underTemp = (p: string) => TEMP_ROOTS.some((root) => p.startsWith(`${root}/`));

/** Whether a path lies below `root` inside a folder with one of `names`; `root`'s own folders don't count. */
const inNamed = (p: string, root: string, names: string[]) =>
  p.startsWith(`${root}/`) &&
  p
    .slice(root.length + 1)
    .split("/")
    .some((part) => names.includes(part));

/**
 * Whether a recursive delete can remove a target without asking: it lies
 * inside a temp directory, and not at its root, or is or lies inside a folder
 * named in `folders`, below the session's folder. Either is judged on the path
 * and on where its symlinks lead. A glob counts only in a path's last part,
 * where what it matches lies inside the folder before it. A relative target
 * counts only when the command changes no directory: pi runs each command from
 * the session's folder.
 */
function exempt(t: string, cwd: string, changesDir: boolean, folders: string[]): boolean {
  // A variable, a substitution or a brace expansion could point anywhere.
  if (/[$`{]/.test(t)) return false;
  const path = expandHome(t);
  // So could .., which resolve() takes as text, past any symlink before it.
  if (path.split("/").includes("..")) return false;
  const glob = path.search(/[*?[]/);
  const last = path.slice(path.lastIndexOf("/") + 1);
  // A glob in an earlier part may pass through symlinks, and .* matches .. in bash 3.2.
  if (glob >= 0 && (path.indexOf("/", glob) >= 0 || /^[.[]/.test(last))) return false;
  const stem = glob < 0 ? path : path.slice(0, path.length - last.length);
  if (!stem || (!isAbsolute(stem) && changesDir)) return false;
  const abs = resolve(cwd, stem);
  // A glob's matches are entries of its folder, so an entry of it is judged.
  const entry = (p: string) => (glob < 0 ? p : join(p, "\0"));
  const [full, real] = [entry(abs), entry(realOrSame(abs))];
  if (underTemp(full) && underTemp(real)) return true;
  return inNamed(full, resolve(cwd), folders) && inNamed(real, realOrSame(resolve(cwd)), folders);
}

/**
 * What a recursive delete needs the user's OK for, if anything: `does`, and
 * what makes a target that isn't exempt impossible to check, a variable or a
 * glob. Empty when every target is exempt.
 */
function deleteReason(
  does: string,
  targets: string[],
  cwd: string,
  changesDir: boolean,
  cfg: Config,
): string {
  const left = targets.filter((t) => !exempt(t, cwd, changesDir, cfg.allowFolders));
  if (targets.length && !left.length) return "";
  const variable = left.find((t) => /[$`]/.test(t));
  if (variable) return `${does}, and ${variable} has a variable in it, so it could point anywhere`;
  const glob = left.find((t) => /[*?[]/.test(t));
  return glob ? `${does}, and ${glob} is a glob, so what it deletes depends on what is there` : does;
}

function operands(argv: string[]): string[] {
  const out: string[] = [];
  let flags = true;
  for (const t of argv.slice(1)) {
    if (flags && t === "--") flags = false;
    else if (!flags || !t.startsWith("-") || t === "-") out.push(t);
  }
  return out;
}

const recursive = (argv: string[]) => {
  const end = argv.indexOf("--");
  return argv
    .slice(1, end < 0 ? undefined : end)
    .some((t) => t === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(t));
};

/** The commands find runs on what it matches: each after -exec, -execdir, -ok or -okdir, up to its ; or +. */
function findRuns(argv: string[]): ReturnType<typeof programOf>[] {
  const runs: ReturnType<typeof programOf>[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(argv[i])) continue;
    const end = argv.findIndex((t, k) => k > i && (t === ";" || t === "+"));
    runs.push(programOf(argv.slice(i + 1, end < 0 ? undefined : end)));
    if (end < 0) break;
    i = end;
  }
  return runs;
}

function findStarts(argv: string[]): string[] {
  let i = 1;
  while (i < argv.length && /^-[HLPEXdsx]$/.test(argv[i])) i++;
  const starts: string[] = [];
  while (i < argv.length && !argv[i].startsWith("-") && argv[i] !== "(" && argv[i] !== "!")
    starts.push(argv[i++]);
  return starts.length ? starts : ["."];
}

/** What a deleting find deletes: its starts, and what each rm it runs names besides the match ({}). */
function findTargets(argv: string[], runs: ReturnType<typeof programOf>[]): string[] {
  const named = runs
    .filter((r) => r.name === "rm")
    .flatMap((r) => operands(r.argv).filter((t) => t !== "{}"));
  return [...findStarts(argv), ...named];
}

function argMatches(spec: string, tok: string): boolean {
  if (tok === spec) return true;
  if (/^--[^=]+$/.test(spec) && tok.startsWith(`${spec}=`)) return true;
  return /^-[A-Za-z0-9]$/.test(spec) && /^-[A-Za-z0-9]+$/.test(tok) && tok.includes(spec[1]);
}

/** Whether a command starts with the rule's words, in order, and has one of its args. */
export function ruleMatches(rule: Rule, argv: string[]): boolean {
  const words = rule.command.trim().split(/\s+/);
  if (!argv.length || base(argv[0]) !== base(words[0])) return false;
  let i = 1;
  for (const w of words.slice(1)) {
    while (i < argv.length && argv[i] !== w) i++;
    if (i >= argv.length) return false;
    i++;
  }
  return !rule.args || argv.slice(i).some((t) => rule.args?.some((spec) => argMatches(spec, t)));
}

/** Why a command line needs the user's OK; empty when it doesn't. */
export function check(line: string, cwd: string, cfg: Config): string[] {
  const reasons: string[] = [];
  const commands = commandsOf(line);
  const changesDir = commands.some((c) => ["cd", "pushd", "popd"].includes(c.name));
  for (const { argv, name, wrappers } of commands) {
    // find runs its -exec commands itself, sudo and all.
    const runs = name === "find" ? findRuns(argv) : [];
    const asRoot = [wrappers, ...runs.map((r) => r.wrappers)].flat();
    if (cfg.builtins.includes("sudo") && asRoot.some((w) => w === "sudo" || w === "doas"))
      reasons.push("runs as root");
    if (!argv.length) continue;
    if (cfg.builtins.includes("rm") && name === "rm" && recursive(argv)) {
      // xargs adds what it reads to the operands, so they can't be judged.
      const targets = wrappers.includes("xargs") ? [] : operands(argv);
      reasons.push(deleteReason("deletes recursively", targets, cwd, changesDir, cfg));
    }
    if (
      cfg.builtins.includes("find") &&
      name === "find" &&
      (argv.includes("-delete") || runs.some((r) => r.name === "rm"))
    ) {
      reasons.push(
        deleteReason("deletes the files find matches", findTargets(argv, runs), cwd, changesDir, cfg),
      );
    }
    for (const rule of cfg.rules) {
      if (ruleMatches(rule, argv))
        reasons.push(
          rule.reason ?? `matches the rule "${rule.command}${rule.args ? ` ${rule.args.join("|")}` : ""}"`,
        );
    }
  }
  return [...new Set(reasons)].filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let cfg: Config = DEFAULTS;
  let subagents: { leave(): void } | undefined;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const { config, problems } = loadConfig(
      (pi.getSettings() as Record<string, unknown>).commandGuard,
      readGlobal("commandGuard"),
    );
    cfg = config;
    if (problems.length) ctx.ui.notify(`command-guard settings ignored: ${problems.join("; ")}`, "warning");
    subagents?.leave();
    subagents = undefined;
    try {
      const path = realpathSync(fileURLToPath(import.meta.url));
      subagents = await joinSubagents(ctx.sessionManager.getSessionId(), "command-guard", path);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`command-guard: subagents will not load this guard: ${why}`, "warning");
    }
  });

  pi.on("session_shutdown", () => {
    subagents?.leave();
    subagents = undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as Record<string, unknown>).command ?? "");
    const reasons = check(command, ctx.cwd, cfg);
    if (!reasons.length) return undefined;
    const why = reasons.join("; ");
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `command-guard: this command ${why}, so it needs the user's OK, and nobody can be asked here. Don't run it another way; report that it needs the user.`,
      };
    }
    const ms = cfg.timeoutSeconds * 1000;
    const started = Date.now();
    const ok = await ctx.ui.confirm(`Run this command? It ${why}.`, command, {
      timeout: ms,
      signal: ctx.signal,
    });
    if (ok) return undefined;
    const timedOut = Date.now() - started >= ms - 1000;
    return {
      block: true,
      reason: `command-guard: ${timedOut ? `no answer within ${cfg.timeoutSeconds} s, so the command was not run` : "the user declined this command"} (it ${why}). Don't retry it in another form; ask the user.`,
    };
  });
}
