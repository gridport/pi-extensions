// A fake pi for the guards: loads an extension, records what it notifies, and
// lets a test call its tool_call and tool_result handlers.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Where fixtures go: test/mutants.sh points this into its own work directory,
// so a test process a mutant kills before cleanup leaves nothing behind.
export const fixtures = process.env.GUARD_TEST_FIXTURES ?? tmpdir();

// Keep the user's own pi settings and pi-subagents out of the tests.
const agent = mkdtempSync(join(fixtures, "guard-agent-"));
process.env.PI_CODING_AGENT_DIR = agent;
process.on("exit", () => rmSync(agent, { recursive: true, force: true }));

type Handler = (...args: any[]) => any;

export function load(
  ext: (pi: any) => void,
  opts: {
    settings?: Record<string, unknown>;
    hasUI?: boolean;
    confirm?: (title: string, message: string, o: any) => Promise<boolean>;
  } = {},
) {
  const handlers: Record<string, Handler> = {};
  const notes: [string, string][] = [];
  const asked: { title: string; message: string; opts: any }[] = [];
  let cwd = "/work";
  const pi: any = {
    on: (e: string, h: Handler) => (handlers[e] = h),
    getSettings: () => structuredClone(opts.settings ?? {}),
  };
  const ctx = (dir: string): any => ({
    cwd: dir,
    hasUI: opts.hasUI ?? true,
    signal: undefined,
    ui: {
      notify: (m: string, t: string) => notes.push([t, m]),
      confirm: async (title: string, message: string, o: any) => {
        asked.push({ title, message, opts: o });
        return opts.confirm ? opts.confirm(title, message, o) : false;
      },
    },
    sessionManager: { getSessionId: () => "test-session" },
  });
  ext(pi);
  return {
    notes,
    asked,
    /** Starts the session; later calls default to its working directory. */
    start: (dir = "/work") => {
      cwd = dir;
      return handlers.session_start?.({ reason: "startup" }, ctx(dir));
    },
    stop: () => handlers.session_shutdown?.({ reason: "quit" }),
    call: (toolName: string, input: Record<string, unknown>, dir = cwd) =>
      handlers.tool_call({ type: "tool_call", toolCallId: "t", toolName, input }, ctx(dir)),
    result: (
      toolName: string,
      input: Record<string, unknown>,
      text: string,
      structuredContent?: unknown,
      details?: unknown,
    ) =>
      handlers.tool_result(
        {
          type: "tool_result",
          toolCallId: "t",
          toolName,
          input,
          content: [{ type: "text", text }],
          structuredContent,
          details,
          isError: false,
        },
        ctx(cwd),
      ),
  };
}

/**
 * Installs a fake pi-subagents in the test agent directory. Like the real one,
 * it refuses a second registration for a session until the first is disposed.
 * `registered(session)` lists the extensions registered for a session, and
 * `register` registers some as another extension would.
 */
export async function fakeSubagents() {
  const dir = join(agent, "npm", "node_modules", "pi-subagents", "bundle");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "required-child-extensions.js");
  writeFileSync(
    file,
    `const store = new Map();
export function registerRequiredChildExtensions({ sessionId, extensions }) {
  if (store.has(sessionId)) throw new Error("Required child extensions are already registered for session '" + sessionId + "'; dispose them first.");
  store.set(sessionId, extensions);
  return { dispose() { if (store.get(sessionId) === extensions) store.delete(sessionId); } };
}
export const registered = (sessionId) => store.get(sessionId) ?? [];
`,
  );
  const mod = await import(pathToFileURL(file).href);
  return {
    registered: (session = "test-session"): { id: string; path: string }[] => mod.registered(session),
    register: (sessionId: string, extensions: { id: string; path: string }[]): { dispose(): void } =>
      mod.registerRequiredChildExtensions({ sessionId, extensions }),
    remove: () => rmSync(join(agent, "npm"), { recursive: true, force: true }),
  };
}
