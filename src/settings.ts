// pi's agent directory and its global settings.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./paths.ts";

/** pi's agent directory, found as pi finds it: PI_CODING_AGENT_DIR with ~ expanded, or ~/.pi/agent. */
export const agentDir = () => expandHome(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));

/**
 * One key of the global settings.json. pi's merged settings let a project's
 * list replace a global one, so the guards read the global file themselves.
 */
export function readGlobal(key: string): unknown {
  try {
    return JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"))?.[key];
  } catch {
    return undefined;
  }
}

const record = (v: unknown) => (v && typeof v === "object" ? v : {}) as Record<string, unknown>;

/**
 * A guard's settings, read so that a project's can't weaken it: the global
 * settings decide, and a project's can only add to a list. `merged` is pi's
 * merged view of the guard's settings, `global` the global file's.
 */
export function layered(merged: unknown, global: unknown) {
  const [m, g] = [record(merged), record(global)];
  return {
    /**
     * A list a project can add to: the global list, or `fallback` when the
     * global value isn't a list by `isList`, then a project's entries.
     */
    projectAdds: <T>(key: string, fallback: T[], isList: (v: unknown) => v is T[]): T[] => [
      ...new Set([...(isList(g[key]) ? g[key] : fallback), ...(isList(m[key]) ? m[key] : [])]),
    ],
    /** A value only the global settings set. */
    globalOnly: (key: string): unknown => g[key],
  };
}
