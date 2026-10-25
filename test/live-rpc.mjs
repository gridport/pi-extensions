// What the live tests share: real pi over RPC, loading only the extensions
// under test, with a cheap model through magpie (PI_TEST_MODEL picks another).
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

export const here = import.meta.dirname;
export const extensions = path.join(here, "..", "extensions");
export const MODEL = process.env.PI_TEST_MODEL ?? "magpie/anthropic/claude-haiku-5-5";

export const ts = () => new Date().toTimeString().slice(0, 8);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The text parts of a message. */
export const text = (m) =>
  typeof m.content === "string"
    ? m.content
    : (m.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(" ");

const results = [];
export function check(name, ok, info = "") {
  results.push({ name, ok });
  console.log(`${ts()} ${ok ? "PASS" : "FAIL"} ${name} ${info}`);
}

/** Prints the tally and exits, failing if any check failed. */
export function finish(note = "") {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${note}`);
  process.exit(failed.length ? 1 : 0);
}

/**
 * Starts pi in RPC mode with only the given extensions and calls onEvent with
 * each event it emits. Its stderr is logged under the run's name.
 */
export function rpc(name, { cwd, load, extra = [] }, onEvent) {
  const args = [
    "--mode",
    "rpc",
    "--session-dir",
    path.join(here, `sessions-${name}`),
    "--model",
    MODEL,
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-mcp",
    ...load.flatMap((e) => ["-e", e]),
    ...extra,
  ];
  const p = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: p.stdout }).on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    onEvent(event);
  });
  p.stderr.on("data", (d) => {
    const t = String(d).trim();
    if (t) console.log(`${ts()} [${name} stderr] ${t.slice(0, 300)}`);
  });
  const exited = new Promise((r) => p.on("exit", r));
  return {
    send: (cmd) => p.stdin.write(`${JSON.stringify(cmd)}\n`),
    stop: async () => {
      p.stdin.end();
      await exited;
    },
  };
}
