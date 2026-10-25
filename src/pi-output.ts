// pi's ways with a tool's output: its file of a long bash command's full
// output, how it cuts output off, the lines it adds after it, and what a
// tool_result handler returns to replace it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./paths.ts";
import { base } from "./shell.ts";

// pi's file of a long bash command's full output, which the model is told to read:
const BASH_LOG = /^pi-bash-[0-9a-f]+\.log$/;
// its notice under the tail it shows, saying where the tail starts and naming that file;
const NOTICE =
  /^\[Showing (?:lines (\d+)-\d+ of \d+(?: \([^)\n]*\))?|last .+? of line (\d+) \(line is [^)\n]*\))\. Full output: (.+)\]$/;
// where its copy for codemode leaves out the middle of output over 1 MiB, the
// copy keeping the file's first and last halves of that;
const OMISSION = /^\[\.\.\. \d+ bytes omitted \.\.\.\]$/;
const CODEMODE_BYTES = 1024 * 1024;
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

/**
 * A file's bytes, its path resolved as pi resolves a tool's: ~ expanded, or a
 * file URL taken as its path, then from cwd. None if there is no such file. One
 * that is there but can't be read, such as one over 2 GiB, could hold
 * anything, so that throws.
 */
function bytesOf(path: string, cwd: string): Buffer | undefined {
  try {
    const p = path.startsWith("file://") ? fileURLToPath(path) : expandHome(path);
    return readFileSync(resolve(cwd, p));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

const NL = 0x0a;
// How much of a file is decoded at a time; a longer line is decoded whole.
const CHUNK = 1024 * 1024;

/**
 * A file's first `n` lines, as slice would count them, or all of them. They are
 * decoded a chunk at a time as they are read, so a file longer than V8's
 * longest string reads too, and they can be read more than once.
 */
function linesIn(buf: Buffer, n = Number.POSITIVE_INFINITY): Iterable<string> {
  const count = Math.trunc(n);
  return {
    *[Symbol.iterator]() {
      let i = 0;
      for (let start = 0; i < count; ) {
        const nl = buf.indexOf(NL, start + CHUNK);
        const end = nl < 0 ? buf.length : nl;
        for (const line of buf.subarray(start, end).toString("utf8").split("\n")) {
          if (i++ === count) return;
          yield line;
        }
        if (nl < 0) return;
        start = nl + 1;
      }
    },
  };
}

/** A file's lines, its path resolved as a tool's. None if there is no such file; throws if it can't be read. */
export function linesOf(path: string, cwd: string): Iterable<string> {
  const buf = bytesOf(path, cwd);
  return buf ? linesIn(buf) : [];
}

/** How pi cut a bash command's output for the model: the lines it left out of the head, whether the tail is the end of one long line, and the file that holds it all. */
type Cut = { hidden: number; partial: boolean; log: string };

/** pi's notice in a line, if it names pi's own file: how it cut the output. */
function notice(line: string): Cut | undefined {
  const m = NOTICE.exec(line);
  if (!m || !isBashLog(m[3])) return undefined;
  return { hidden: Number(m[1] ?? m[2]) - 1, partial: m[2] !== undefined, log: m[3] };
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

/** How pi cut a bash command's output for the model, if it did. */
function bashCut(event: ToolOutput): Cut | undefined {
  const d = event.details as {
    truncation?: { totalLines?: number; outputLines?: number; lastLinePartial?: boolean };
    fullOutputPath?: unknown;
  };
  if (typeof d?.fullOutputPath === "string") {
    return {
      hidden: (d.truncation?.totalLines ?? 0) - (d.truncation?.outputLines ?? 0),
      partial: d.truncation?.lastLinePartial === true,
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

/**
 * Where a copy of a tool's output sits in the whole of it: `before`, the
 * whole's lines before the copy starts; `parts`, the copy's lines, by index,
 * that hold only part of a line of the whole, with that line; and `omission`,
 * where codemode's copy leaves out its middle: the index of its marker's line,
 * and the whole's lines before the copy resumes.
 */
export interface Placement {
  before: Iterable<string>;
  parts: Map<number, string>;
  omission?: { at: number; before: Iterable<string> };
}

/** A copy that is all of a tool's output. */
export const WHOLE: Placement = { before: [], parts: new Map() };

/** How many lines of `buf` end before byte `end`. */
function linesBefore(buf: Buffer, end: number): number {
  let n = 0;
  for (let i = buf.indexOf(NL); i >= 0 && i < end; i = buf.indexOf(NL, i + 1)) n++;
  return n;
}

/** The line of `buf` that byte `i` (above 0) is in, the newline that ends it not counted. */
function lineAt(buf: Buffer, i: number): string {
  const end = buf.indexOf(NL, i);
  return buf.subarray(buf.lastIndexOf(NL, i - 1) + 1, end < 0 ? buf.length : end).toString("utf8");
}

/**
 * Where codemode's copy of a bash command's output sits in pi's file of it:
 * over 1 MiB, it is the file's first half MiB, a blank line, the marker, a
 * blank line and its last half MiB. Either half may hold part of a line at the
 * cut. pi moves each cut to where a character starts, which keeps it in the
 * same line, since no byte of a character but its first can be a newline.
 */
function codemodeCopy(log: Buffer): Placement {
  if (log.length <= CODEMODE_BYTES) return WHOLE;
  const headEnd = CODEMODE_BYTES / 2;
  const tailStart = log.length - (CODEMODE_BYTES - headEnd);
  const at = linesBefore(log, headEnd) + 2;
  const parts = new Map<number, string>();
  if (log[headEnd - 1] !== NL) parts.set(at - 2, lineAt(log, headEnd - 1));
  if (log[tailStart - 1] !== NL) parts.set(at + 2, lineAt(log, tailStart));
  return { before: [], parts, omission: { at, before: linesIn(log, linesBefore(log, tailStart)) } };
}

/**
 * Where each copy of a tool's output sits in the whole of it: `text`, what the
 * model is shown, and `structured`, codemode's copy. A read from an offset
 * starts partway through its file. A bash command's tail starts after lines
 * only pi's file of the full output holds, partway through a line when its one
 * line is too long, and codemode's copy of output over 1 MiB leaves out a
 * middle part.
 */
export function placeOf(event: ToolOutput, cwd: string): { text: Placement; structured: Placement } {
  if (event.toolName === "read") {
    const offset = typeof event.input.offset === "number" ? event.input.offset : 1;
    const file = offset > 1 ? bytesOf(toolPath(event.input) ?? "", cwd) : undefined;
    const place = { before: file ? linesIn(file, offset - 1) : [], parts: new Map() };
    return { text: place, structured: place };
  }
  const cut = bashCut(event);
  const log = cut && bytesOf(cut.log, cwd);
  if (!cut || !log) return { text: WHOLE, structured: WHOLE };
  const hidden = Math.max(0, cut.hidden);
  const parts = new Map<number, string>();
  if (cut.partial) {
    let i = 0;
    for (const line of linesIn(log, hidden + 1)) if (i++ === hidden) parts.set(0, line);
  }
  return { text: { before: linesIn(log, hidden), parts }, structured: codemodeCopy(log) };
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
