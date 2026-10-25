// pi's ways with a tool's output: its file of a long bash command's full
// output, how it cuts output off, the lines it adds after it, and what a
// tool_result handler returns to replace it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./paths.ts";
import { base } from "./shell.ts";

// pi's file of a long bash command's full output, which the model is told to read:
const BASH_LOG = /^pi-bash-[0-9a-f]+\.log$/;
// its notice under the tail it shows, saying where the tail starts and naming that file;
const NOTICE =
  /^\[Showing (?:lines (\d+)-\d+ of \d+(?: \([^)\n]*\))?|last .+? of line (\d+) \(line is [^)\n]*\))\. Full output: (.+)\]$/;
// where its copy for codemode leaves out the middle of output over 1 MB;
const OMISSION = /^\[\.\.\. \d+ bytes omitted \.\.\.\]$/;
// and its other lines after a tool's output: bash's exit status, and read's hints for reading on.
const STATUS =
  /^(?:Command (?:exited with code \d+|aborted|timed out after \d+ seconds|terminated without an exit code)|\[(?:Showing lines \d+-\d+ of \d+(?: \([^)\n]*\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\])$/;

/** The parts of a tool_result event read here; a failed call's has only its text, and empty details. */
export type ToolOutput = Pick<ToolResultEvent, "content" | "structuredContent"> & {
  toolName: string;
  input: Record<string, unknown>;
  details?: unknown;
};

type Rewrite = (text: string) => string;

/** Whether a path names pi's file of a long bash command's full output. */
export const isBashLog = (path: string) => BASH_LOG.test(base(path));

/** Whether a line is where codemode's copy of a long output leaves out its middle. */
export const isOmission = (line: string) => OMISSION.test(line);

/** The path a file tool's input names, without the @ pi drops from it, as its @ file mentions carry one. */
export const toolPath = (input: Record<string, unknown>) =>
  typeof input.path === "string" ? input.path.replace(/^@/, "") : undefined;

/** A file's lines, its path resolved as pi resolves a tool's: ~ expanded, then from cwd. None if it can't be read. */
export function linesOf(path: string, cwd: string): string[] {
  try {
    return readFileSync(resolve(cwd, expandHome(path)), "utf8").split("\n");
  } catch {
    return [];
  }
}

/** pi's notice in a line, if it names pi's own file: how many lines it left out of the head, and that file. */
function notice(line: string): { hidden: number; log: string } | undefined {
  const m = NOTICE.exec(line);
  return m && isBashLog(m[3]) ? { hidden: Number(m[1] ?? m[2]) - 1, log: m[3] } : undefined;
}

/**
 * A tool's text split into its output and the lines pi adds after it, each
 * after a blank line: bash's notice and exit status, read's hints for reading
 * on.
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
function bashCut(event: ToolOutput): { hidden: number; log: string } | undefined {
  const d = event.details as {
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
  const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return splitTrailer(text)[1]
    .split("\n")
    .map(notice)
    .findLast((n) => n !== undefined);
}

/** What pi left out of one copy of a tool's output: the lines before it starts, and those its omission marker may stand for. */
export interface LeftOut {
  head: string[];
  middle?: string[];
}

/**
 * What pi left out of each copy of a tool's output: `text`, what the model is
 * shown, and `structured`, codemode's copy. A read from an offset starts
 * partway through its file. A bash command's tail starts after lines only pi's
 * file of the full output holds, and codemode's copy of output over 1 MB leaves
 * out a middle part, which may be any of that file's lines.
 */
export function leftOut(event: ToolOutput, cwd: string): { text: LeftOut; structured: LeftOut } {
  if (event.toolName === "read") {
    const offset = typeof event.input.offset === "number" ? event.input.offset : 1;
    const head = offset > 1 ? linesOf(toolPath(event.input) ?? "", cwd).slice(0, offset - 1) : [];
    return { text: { head }, structured: { head } };
  }
  const cut = bashCut(event);
  if (!cut) return { text: { head: [] }, structured: { head: [] } };
  const lines = linesOf(cut.log, cwd);
  return {
    text: { head: lines.slice(0, Math.max(0, cut.hidden)) },
    structured: { head: [], middle: lines },
  };
}

const mapStrings = (v: unknown, f: Rewrite): unknown =>
  typeof v === "string"
    ? f(v)
    : Array.isArray(v)
      ? v.map((x) => mapStrings(x, f))
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]))
        : v;

/**
 * What a tool_result handler returns to replace a tool's output, or undefined
 * when nothing changes. `text` rewrites what the model is shown, and
 * `structured` each string of codemode's copy. Neither sees the lines pi adds
 * after the output, which stay as they are: in the text, and in read's copy,
 * which is the text; bash's copy is the bare output.
 */
export function patchResult(
  event: ToolOutput,
  text: Rewrite,
  structured: Rewrite = text,
): ToolResultEventResult | undefined {
  const keep = (f: Rewrite) => (t: string) => {
    const [body, trailer] = splitTrailer(t);
    return f(body) + trailer;
  };
  const before = event.content;
  const after = before.map((c) =>
    c.type === "text" && typeof c.text === "string" ? { ...c, text: keep(text)(c.text) } : c,
  );
  const textOf = (c: (typeof before)[number]) => (c.type === "text" ? c.text : undefined);
  const changed = after.some((c, i) => textOf(c) !== textOf(before[i]));
  // Codemode scripts get structuredContent, such as bash's whole output, in place of the text.
  const copy =
    event.structuredContent === undefined
      ? undefined
      : mapStrings(event.structuredContent, event.toolName === "bash" ? structured : keep(structured));
  if (!changed && JSON.stringify(copy) === JSON.stringify(event.structuredContent)) return undefined;
  return {
    ...(changed ? { content: after } : {}),
    ...(copy === undefined ? {} : { structuredContent: copy as ToolResultEventResult["structuredContent"] }),
  };
}
