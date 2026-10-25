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
 *   timeoutSeconds  How long the question waits before it counts as a no.
 *                   Default 120.
 *
 * Commands are split as the shell would split them, so pipelines, && chains,
 * bash -c '…', eval, xargs, env and sudo are looked into, and so is what echo
 * or a here-document pipes into a shell, while text inside a
 * quoted argument or a here-document, such as a commit message, is not taken
 * for a command. A recursive rm or find whose targets all lie inside a temp
 * directory runs without asking. Where nobody can be asked (print mode,
 * subagents), the command is refused. With pi-subagents installed, its
 * subagents load this guard too.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expandHome, realOrSame } from "../src/paths.ts";
import { readGlobal } from "../src/settings.ts";
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
  timeoutSeconds: number;
}

export const DEFAULTS: Config = { builtins: ["rm", "sudo", "find"], rules: [], timeoutSeconds: 120 };
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
 * rules. The timeout comes from the global settings alone.
 */
export function loadConfig(merged: unknown, global: unknown): { config: Config; problems: string[] } {
  const m = (merged ?? {}) as Record<string, unknown>;
  const g = (global ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const gBuiltins = Array.isArray(g.builtins) ? g.builtins : DEFAULTS.builtins;
  const builtins = [...new Set([...gBuiltins, ...list(m.builtins)])].filter((b) => {
    if (BUILTINS.has(b)) return true;
    problems.push(`unknown builtin ${JSON.stringify(b)}`);
    return false;
  });
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const r of [...list(g.rules), ...list(m.rules)]) {
    if (!validRule(r)) {
      problems.push(`invalid rule ${JSON.stringify(r)}`);
      continue;
    }
    const key = JSON.stringify(r);
    if (!seen.has(key)) rules.push(r);
    seen.add(key);
  }
  const t = g.timeoutSeconds;
  const timeoutSeconds = typeof t === "number" && t > 0 ? t : DEFAULTS.timeoutSeconds;
  if (t !== undefined && timeoutSeconds !== t) problems.push(`invalid timeoutSeconds ${JSON.stringify(t)}`);
  return { config: { builtins, rules, timeoutSeconds }, problems };
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

/**
 * Whether every target lies inside a temp directory, and not at its root. A
 * relative target counts only when the session itself works in a temp
 * directory and the command changes no directory.
 */
export function allInTemp(targets: string[], cwd: string, changesDir: boolean): boolean {
  if (!targets.length) return false;
  return targets.every((t) => {
    // A variable, a substitution or a brace expansion could point anywhere.
    if (/[$`{]/.test(t)) return false;
    // So could .. after a glob, which the stem below leaves out.
    const glob = t.search(/[*?[]/);
    if (glob >= 0 && t.slice(glob).split("/").includes("..")) return false;
    const stem = expandHome(t).split(/[*?[]/)[0];
    if (!stem || (!isAbsolute(stem) && (changesDir || !underTemp(realOrSame(cwd))))) return false;
    const abs = resolve(cwd, stem);
    return underTemp(abs) && underTemp(realOrSame(abs));
  });
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
    if (
      cfg.builtins.includes("rm") &&
      name === "rm" &&
      recursive(argv) &&
      !allInTemp(operands(argv), cwd, changesDir)
    ) {
      reasons.push("deletes recursively");
    }
    if (
      cfg.builtins.includes("find") &&
      name === "find" &&
      (argv.includes("-delete") || runs.some((r) => r.name === "rm")) &&
      !allInTemp(findStarts(argv), cwd, changesDir)
    ) {
      reasons.push("deletes the files find matches");
    }
    for (const rule of cfg.rules) {
      if (ruleMatches(rule, argv))
        reasons.push(
          rule.reason ?? `matches the rule "${rule.command}${rule.args ? ` ${rule.args.join("|")}` : ""}"`,
        );
    }
  }
  return [...new Set(reasons)];
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
