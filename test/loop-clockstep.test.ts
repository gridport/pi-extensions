import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { env, T } from "./loop-harness.ts";

// Real timers ignore wall-clock steps, so mock only setTimeout and drive
// Date.now separately: stepping the wall clock back leaves the timers alone.
test("a clock stepped back does not resend a minute", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let wall = T("2026-10-25T13:00:30");
  mock.method(Date, "now", () => wall);
  const step = (ms: number) => {
    wall += ms;
    mock.timers.tick(ms);
  };
  try {
    const e = env();
    e.handlers.session_start({ reason: "startup" }, e.ctx);
    await e.create("7 * * * *", "check");
    for (let i = 0; i < 7; i++) step(60_000); // to 13:07:30
    assert.equal(e.sent.length, 1);
    assert.match(e.sent[0], /due 2026-10-25 13:07\]/);
    wall -= 3 * 60_000; // NTP steps the clock back to 13:04:30
    for (let i = 0; i < 5; i++) step(60_000); // through 13:07 again, to 13:09:30
    assert.equal(e.sent.length, 1, "13:07 is not sent twice");
    for (let i = 0; i < 58; i++) step(60_000); // to 14:07:30
    assert.equal(e.sent.length, 2, "the schedule carries on");
  } finally {
    mock.timers.reset();
    mock.restoreAll();
  }
});
