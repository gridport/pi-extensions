// Makes pi-subagents' children load the guards. pi-subagents accepts one
// registration per session, so the guards share it: each joins, and the
// registration is redone to list every guard that has joined.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentDir } from "./settings.ts";

interface Session {
  members: Map<string, string>;
  registration?: { dispose(): void };
}

// Kept on globalThis, since pi may load this file once for each guard.
const KEY = Symbol.for("@gridport/pi-extensions/subagents");
function sessions(): Map<string, Session> {
  const g = globalThis as unknown as Record<symbol, Map<string, Session> | undefined>;
  g[KEY] ??= new Map();
  return g[KEY];
}

/**
 * Adds an extension to the session's registration. Returns undefined when
 * pi-subagents isn't installed in pi's npm directory; throws when pi-subagents
 * refuses the registration, as it does when another extension holds one.
 */
export async function joinSubagents(
  sessionId: string,
  id: string,
  path: string,
): Promise<{ leave(): void } | undefined> {
  const api = join(
    agentDir(),
    "npm",
    "node_modules",
    "pi-subagents",
    "bundle",
    "required-child-extensions.js",
  );
  if (!existsSync(api)) return undefined;
  const { registerRequiredChildExtensions } = await import(pathToFileURL(api).href);
  const all = sessions();
  const session: Session = all.get(sessionId) ?? { members: new Map() };
  all.set(sessionId, session);
  const sync = () => {
    session.registration?.dispose();
    session.registration = undefined;
    if (!session.members.size) {
      all.delete(sessionId);
      return;
    }
    const extensions = [...session.members].map(([id, path]) => ({ id, path }));
    session.registration = registerRequiredChildExtensions({ sessionId, extensions });
  };
  session.members.set(id, path);
  try {
    sync();
  } catch (err) {
    // pi-subagents refused: another extension holds the session's registration.
    session.members.delete(id);
    if (!session.members.size) all.delete(sessionId);
    throw err;
  }
  return {
    leave() {
      if (!session.members.delete(id)) return;
      try {
        sync();
      } catch {
        // Nothing left to tell: the session is ending or reloading.
      }
    },
  };
}
