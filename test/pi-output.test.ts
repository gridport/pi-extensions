// pi's ways with a tool's output, checked against pi's own bash and read tools,
// run in-process, so a pi upgrade that changes them fails here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createBashToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  isBashLog,
  isOmission,
  leftOut,
  linesOf,
  patchResult,
  type ToolOutput,
  toolPath,
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
  const left = leftOut(out, fixtures);
  assert.deepEqual(left.text.head, numbers(1, 1000), "the lines before the tail");
  assert.deepEqual(left.structured, { head: [], middle: linesOf(log, fixtures) });
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
  assert.deepEqual(leftOut(out, fixtures).text.head, numbers(1, 1000));
  assert.ok(textOf(patchResult(out, digits)).endsWith(trailer), "pi's lines stay");
});

test("a failed command's exit status is pi's", async () => {
  const out = await run("bash", { command: "echo 1; exit 3" }, fixtures);
  assert.equal(textOf(out), "1\n\n\nCommand exited with code 3");
  assert.deepEqual(leftOut(out, fixtures).text, { head: [] }, "nothing was cut");
  assert.equal(textOf(patchResult(out, digits)), "#\n\n\nCommand exited with code 3");
});

test("codemode's copy of bash output is the bare output, with no lines of pi's", async () => {
  const out = await run("bash", { command: "printf 'Command exited with code 9'" }, fixtures);
  const copy = patchResult(out, (s) => s.toUpperCase())?.structuredContent as { output: string };
  assert.equal(copy.output, "COMMAND EXITED WITH CODE 9");
});

test("codemode's copy of output over 1 MB leaves out its middle", async (t) => {
  const out = await run("bash", { command: "yes 0123456789 | head -n 110000" }, fixtures);
  logOf(t, out);
  const copy = out.structuredContent as { output: string; truncated: boolean };
  assert.ok(copy.truncated);
  assert.equal(copy.output.split("\n").filter(isOmission).length, 1);
  assert.ok(!isOmission("[... many bytes omitted ...]"));
});

test("a read from an offset, and pi's hints for reading on", async (t) => {
  const dir = mkdtempSync(join(fixtures, "pi-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "f.txt"), numbers(1, 10).join("\n"));
  const out = await run("read", { path: "f.txt", offset: 4, limit: 3 }, dir);
  const hint = "\n\n[4 more lines in file. Use offset=7 to continue.]";
  assert.equal(textOf(out), `4\n5\n6${hint}`);
  assert.deepEqual(leftOut(out, dir), {
    text: { head: ["1", "2", "3"] },
    structured: { head: ["1", "2", "3"] },
  });
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

test("a read's path, as pi takes it: @ dropped, then ~ expanded", async (t) => {
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
  assert.deepEqual(leftOut(out, fixtures).text.head, ["1", "2"]);
});
