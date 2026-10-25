// loop.ts on a fake clock and a fake pi: delivery, coalescing, reload, expiry.

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { env, T } from "./loop-harness.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: T("2026-10-25T13:00:30") }));
afterEach(() => mock.timers.reset());

test("compaction delay, coalescing and 7-day expiry", async () => {
  const e = env();
  e.handlers.session_start({ reason: "startup" }, e.ctx);
  await e.create("7 * * * *", "check");
  mock.timers.tick(7 * 60_000); // 13:07:30
  assert.equal(e.sent.length, 1);
  assert.match(e.sent[0], /due 2026-10-25 13:07\]/);
  e.state.idle = false; // compacting from 14:00 to 16:30: no run, so no agent_settled
  mock.timers.tick(60 * 60_000);
  mock.timers.tick(150 * 60_000); // 16:37:30
  assert.equal(e.sent.length, 1, "nothing is sent while not idle");
  e.state.idle = true;
  mock.timers.tick(60_000);
  assert.equal(e.sent.length, 2, "one coalesced firing, with no settle event");
  assert.match(e.sent[1], /due 2026-10-25 14:07\]/);
  mock.timers.tick(30 * 60_000); // 17:08:30
  assert.match(e.sent[2], /due 2026-10-25 17:07\]/);
  for (let h = 0; h < 7 * 24; h++) mock.timers.tick(60 * 60_000);
  // 18:07 on day 1 through 12:07 on day 7 (it expires at 13:00:30): 6 + 6 * 24 + 13 = 163 more.
  assert.equal(e.sent.length, 3 + 163);
  assert.match(e.sent.at(-1) ?? "", /due 2026-11-01 12:07\]/);
  assert.ok(e.notes.some(([t, m]) => t === "warning" && /expired after 7 days/.test(m)));
  assert.equal(await e.list(), "No loop jobs.");
});

test("a job created in its own minute waits for the next match", async () => {
  mock.timers.setTime(T("2026-10-25T13:07:30"));
  const e = env();
  e.handlers.session_start({ reason: "startup" }, e.ctx);
  await e.create("7 * * * *", "check");
  mock.timers.tick(59 * 60_000); // 14:06:30
  assert.equal(e.sent.length, 0);
  mock.timers.tick(60_000);
  assert.match(e.sent[0], /due 2026-10-25 14:07\]/);
});

test("pending messages hold delivery; the oldest firing goes first", async () => {
  const e = env();
  e.handlers.session_start({ reason: "startup" }, e.ctx);
  await e.create("7 * * * *", "early");
  await e.create("9 * * * *", "late");
  e.state.pending = true;
  mock.timers.tick(10 * 60_000); // 13:10:30, both due
  assert.equal(e.sent.length, 0, "a queued message holds delivery");
  e.state.pending = false;
  mock.timers.tick(60_000);
  assert.equal(e.sent.length, 1, "one per idle moment");
  assert.match(e.sent[0], /early/);
  e.handlers.agent_settled({ aborted: false }, e.ctx);
  assert.match(e.sent[1], /late/);
});

test("Esc holds pending firings for 5 minutes", async () => {
  const e = env();
  e.handlers.session_start({ reason: "startup" }, e.ctx);
  await e.create("7 * * * *", "check");
  e.state.idle = false;
  mock.timers.tick(10 * 60_000); // 13:10:30, due since 13:07
  e.state.idle = true;
  e.handlers.agent_settled({ aborted: true }, e.ctx);
  mock.timers.tick(4 * 60_000); // 13:14:30
  assert.equal(e.sent.length, 0, "held after Esc");
  mock.timers.tick(60_000); // 13:15:30
  assert.equal(e.sent.length, 1);
  assert.match(e.sent[0], /due 2026-10-25 13:07\]/);
});

test("reload in the minute-boundary window loses no firing", async () => {
  const entries: any[] = [];
  const a = env(entries);
  a.handlers.session_start({ reason: "startup" }, a.ctx);
  await a.create("7 * * * *", "check");
  mock.timers.tick(6 * 60_000); // 13:06:30: the old runtime has checked through 13:06
  mock.timers.setTime(T("2026-10-25T13:06:59.600")); // its 13:07:00.250 tick has not run
  a.handlers.session_shutdown({ reason: "reload" });
  mock.timers.setTime(T("2026-10-25T13:07:00.100"));
  const b = env(entries);
  b.handlers.session_start({ reason: "reload" }, b.ctx);
  mock.timers.tick(61_000);
  assert.equal(a.sent.length + b.sent.length, 1);
  assert.match(b.sent[0], /due 2026-10-25 13:07\]/);
});

test("a reload after a firing does not send it again", async () => {
  const entries: any[] = [];
  const a = env(entries);
  a.handlers.session_start({ reason: "startup" }, a.ctx);
  await a.create("7 * * * *", "check");
  mock.timers.tick(30 * 60_000); // 13:30:30, 13:07 sent
  a.handlers.session_shutdown({ reason: "reload" });
  const b = env(entries);
  b.handlers.session_start({ reason: "reload" }, b.ctx);
  mock.timers.tick(30 * 60_000); // 14:00:30
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
});

test("a firing pending at reload is delivered after it", async () => {
  const entries: any[] = [];
  const a = env(entries);
  a.handlers.session_start({ reason: "startup" }, a.ctx);
  await a.create("7 * * * *", "check");
  a.state.idle = false;
  mock.timers.tick(8 * 60_000); // 13:08:30, due since 13:07
  a.handlers.session_shutdown({ reason: "reload" });
  const b = env(entries);
  b.handlers.session_start({ reason: "reload" }, b.ctx);
  mock.timers.tick(60_000);
  assert.equal(b.sent.length, 1);
  assert.match(b.sent[0], /due 2026-10-25 13:07\]/);
});

test("duplicate prompts are refused; a one-shot is deleted once sent", async () => {
  const e = env();
  e.handlers.session_start({ reason: "startup" }, e.ctx);
  await e.create("7 * * * *", "check");
  await assert.rejects(e.create("*/5 * * * *", " check "), /already sends this prompt/);
  await e.create("8 * * * *", "once", false);
  mock.timers.tick(8 * 60_000); // 13:08:30: 13:07 sent, 13:08 due
  e.handlers.agent_settled({ aborted: false }, e.ctx);
  assert.deepEqual(
    e.sent.map((s) => s.split("\n\n")[1]),
    ["check", "once"],
  );
  assert.doesNotMatch(await e.list(), /once/);
  mock.timers.tick(60 * 60_000);
  assert.equal(e.sent.filter((s) => s.endsWith("once")).length, 1);
});

test("a restart warns once about lapsed jobs and arms nothing", async () => {
  const entries: any[] = [];
  const a = env(entries);
  a.handlers.session_start({ reason: "startup" }, a.ctx);
  await a.create("7 3 * * *", "nightly");
  a.handlers.session_shutdown({ reason: "quit" });
  const b = env(entries);
  b.handlers.session_start({ reason: "startup" }, b.ctx);
  assert.equal(b.notes.filter(([t]) => t === "warning").length, 1);
  assert.equal(await b.list(), "No loop jobs.");
  const c = env(entries);
  c.handlers.session_start({ reason: "resume" }, c.ctx);
  assert.equal(c.notes.length, 0);
});

test("/loop delete needs an id", async () => {
  const e = env();
  e.handlers.session_start({ reason: "startup" }, e.ctx);
  await e.command().handler("delete", e.ctx);
  assert.deepEqual(e.notes.at(-1), ["error", "usage: /loop delete <id|all>"]);
});
