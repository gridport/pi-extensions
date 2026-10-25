// pi's ways with a tool's output, checked against pi's own bash and read tools,
// run in-process, so a pi upgrade that changes them fails here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createBashToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  isBashLog,
  isOmission,
  linesOf,
  patchResult,
  placeOf,
  type ToolOutput,
  toolPath,
  WHOLE,
} from "../src/pi-output.ts";
import { fixtures } from "./guard-harness.ts";

const ctx = { sessionManager: { getSessionId: () => "t", getSessionFile: () => undefined } } as never;

/** A tool's result as its tool_result event carries it. A failed call's, as pi builds it, keeps only the text. */
async function run(
  toolName: "bash" | "read",
  input: Record<string, unknown>,
  cwd: string,
): Promise<ToolOutput> {
  const tool = toolName === "bash" ? createBashToolDefinition(cwd) : createReadToolDefinition(cwd);
  try {
    const r = await tool.execute("t", input as never, undefined, undefined, ctx);
    return {
      toolName,
      input,
      content: r.content,
      details: r.details,
      structuredContent: r.structuredContent,
    };
  } catch (err) {
    return { toolName, input, content: [{ type: "text", text: (err as Error).message }], details: {} };
  }
}

const textOf = (out: { content?: ToolOutput["content"] } | undefined) =>
  (out?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");

/** pi's file of the full output its notice names, removed when the test ends. */
function logOf(t: TestContext, out: ToolOutput): string {
  const log = /Full output: (\S+)\]/.exec(textOf(out))?.[1];
  assert.ok(log, "pi's notice names its file");
  t.after(() => rmSync(log, { force: true }));
  return log;
}

const numbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
const digits = (s: string) => s.replace(/\d/g, "#");

test("a long bash output: its tail, pi's notice under it, and its file of the whole", async (t) => {
  const out = await run("bash", { command: "seq 1 3000" }, fixtures);
  const log = logOf(t, out);
  assert.ok(isBashLog(log));
  assert.ok(!isBashLog(join(fixtures, "notes.log")));
  assert.ok(textOf(out).startsWith("1001\n"));
  const place = placeOf(out, fixtures);
  assert.deepEqual(place.text, { before: numbers(1, 1000), parts: new Map() }, "the lines before the tail");
  assert.equal(place.structured, WHOLE, "codemode's copy, under 1 MiB, is all of it");
  const notice = `\n\n[Showing lines 1001-3000 of 3000. Full output: ${log}]`;
  assert.ok(textOf(out).endsWith(notice));
  const patched = patchResult(out, digits);
  assert.ok(textOf(patched).startsWith("####\n"));
  assert.ok(textOf(patched).endsWith(notice), "pi's notice stays");
  const copy = patched?.structuredContent as { output: string; exit_code: number };
  assert.ok(copy.output.startsWith("#\n#\n"), "codemode's copy is rewritten too");
  assert.equal(copy.exit_code, 0);
});

test("a command that timed out: its result keeps only the text, whose notice says what was cut", async (t) => {
  const out = await run("bash", { command: "seq 1 3000; sleep 5", timeout: 1 }, fixtures);
  const log = logOf(t, out);
  assert.deepEqual(out.details, {});
  const trailer = `\n\n[Showing lines 1001-3000 of 3000. Full output: ${log}]\n\nCommand timed out after 1 seconds`;
  assert.ok(textOf(out).endsWith(trailer));
  assert.deepEqual(placeOf(out, fixtures).text.before, numbers(1, 1000));
  assert.ok(textOf(patchResult(out, digits)).endsWith(trailer), "pi's lines stay");
});

test("a tail of one long line is its end, and pi's notice says so", async (t) => {
  const line = `API_KEY=${"7".repeat(60_000)}`;
  for (const command of [`printf '%s\\n%s' 1 '${line}'`, `printf '%s\\n%s' 1 '${line}'; sleep 5`]) {
    const out = await run("bash", { command, timeout: 1 }, fixtures);
    logOf(t, out);
    const place = placeOf(out, fixtures).text;
    assert.deepEqual(place.before, ["1"], command);
    assert.equal(place.parts.get(0), line, "the whole of the line the tail is part of");
    const tail = textOf(out).split("\n")[0];
    assert.ok(tail.length < line.length && line.endsWith(tail));
  }
});

test("a failed command's exit status is pi's", async () => {
  const out = await run("bash", { command: "echo 1; exit 3" }, fixtures);
  assert.equal(textOf(out), "1\n\n\nCommand exited with code 3");
  assert.deepEqual(placeOf(out, fixtures), { text: WHOLE, structured: WHOLE }, "nothing was cut");
  assert.equal(textOf(patchResult(out, digits)), "#\n\n\nCommand exited with code 3");
});

test("codemode's copy of bash output is the bare output, with no lines of pi's", async () => {
  const out = await run("bash", { command: "printf 'Command exited with code 9'" }, fixtures);
  const copy = patchResult(out, (s) => s.toUpperCase())?.structuredContent as { output: string };
  assert.equal(copy.output, "COMMAND EXITED WITH CODE 9");
});

test("codemode's copy of output over 1 MiB leaves out its middle, at a place known to the byte", async (t) => {
  // seq's lines differ, so each matches one place; é's cut is inside a character.
  for (const command of ["seq 1 200000", "yes 'héllo wörld' | head -n 100000"]) {
    const out = await run("bash", { command }, fixtures);
    const log = linesOf(logOf(t, out), fixtures);
    const copy = (out.structuredContent as { output: string; truncated: boolean }).output.split("\n");
    const { before, parts, omission } = placeOf(out, fixtures).structured;
    assert.ok(omission, command);
    const { at } = omission;
    assert.deepEqual([copy[at - 1], isOmission(copy[at]), copy[at + 1]], ["", true, ""], "the marker's line");
    assert.equal(copy.filter(isOmission).length, 1);
    assert.deepEqual(before, []);
    // The head is the log's first lines, the last of them cut short.
    assert.deepEqual(copy.slice(0, at - 2), log.slice(0, at - 2));
    assert.equal(parts.get(at - 2), log[at - 2]);
    assert.ok(log[at - 2].startsWith(copy[at - 2]) && copy[at - 2] !== log[at - 2]);
    // The tail resumes partway through the line after `before`, and runs to the end.
    const resume = omission.before.length;
    assert.deepEqual(omission.before, log.slice(0, resume));
    assert.equal(parts.get(at + 2), log[resume]);
    assert.ok(log[resume].endsWith(copy[at + 2]) && copy[at + 2] !== log[resume]);
    assert.deepEqual(copy.slice(at + 3), log.slice(resume + 1));
    assert.deepEqual([...parts.keys()], [at - 2, at + 2]);
  }
  assert.ok(!isOmission("[... many bytes omitted ...]"));
});

test("a read from an offset, and pi's hints for reading on", async (t) => {
  const dir = mkdtempSync(join(fixtures, "pi-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "f.txt"), numbers(1, 10).join("\n"));
  const out = await run("read", { path: "f.txt", offset: 4, limit: 3 }, dir);
  const hint = "\n\n[4 more lines in file. Use offset=7 to continue.]";
  assert.equal(textOf(out), `4\n5\n6${hint}`);
  const place = { before: ["1", "2", "3"], parts: new Map() };
  assert.deepEqual(placeOf(out, dir), { text: place, structured: place });
  const patched = patchResult(out, digits);
  assert.equal(textOf(patched), `#\n#\n#${hint}`);
  assert.equal(patched?.structuredContent, `#\n#\n#${hint}`, "read's copy is its text, with pi's lines");
  assert.equal(
    patchResult(out, (s) => s),
    undefined,
    "nothing changed",
  );

  writeFileSync(
    join(dir, "wide.txt"),
    numbers(1, 1000)
      .map((n) => `${n} ${"x".repeat(98)}`)
      .join("\n"),
  );
  const wide = await run("read", { path: "wide.txt" }, dir);
  const limit = "\n\n[Showing lines 1-498 of 1000 (50.0KB limit). Use offset=499 to continue.]";
  assert.ok(textOf(wide).endsWith(limit));
  assert.ok(textOf(patchResult(wide, digits)).endsWith(limit), "a hint at read's byte limit stays");
});

test("a read's path, as pi takes it: @ dropped, then ~ expanded, or a file URL", async (t) => {
  const home = mkdtempSync(join(fixtures, "pi-output-home-"));
  const saved = process.env.HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  writeFileSync(join(home, "f.txt"), "1\n2\n3\n4");
  const out = await run("read", { path: "@~/f.txt", offset: 3 }, fixtures);
  assert.equal(textOf(out), "3\n4", "pi read it");
  assert.equal(toolPath(out.input), "~/f.txt");
  assert.deepEqual(placeOf(out, fixtures).text.before, ["1", "2"]);
  const url = await run("read", { path: pathToFileURL(join(home, "f.txt")).href, offset: 3 }, fixtures);
  assert.equal(textOf(url), "3\n4", "pi read it");
  assert.deepEqual(placeOf(url, fixtures).text.before, ["1", "2"]);
});
