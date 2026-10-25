// Path helpers both guards use.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** A path with a leading ~ or ~/ expanded, as the shell would. */
export const expandHome = (p: string) =>
  p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;

/** Where a path really leads: symlinks resolved in the longest part of it that exists. */
export function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realOrSame(parent), basename(p));
  }
}
