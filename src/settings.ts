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
