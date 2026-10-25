// Cron parsing and matching in loop.ts, in local time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { firstMatch, matches, minuteOf, parseCron } from "../extensions/loop.ts";

const at = (s: string) => new Date(s); // local time
const m = (expr: string, s: string) => matches(parseCron(expr), at(s));

test("hourly off the hour", () => {
  assert.equal(m("7 * * * *", "2026-10-25T13:07:00"), true);
  assert.equal(m("7 * * * *", "2026-10-25T13:08:00"), false);
});
test("lists, ranges, steps", () => {
  assert.equal(m("7,37 * * * *", "2026-10-25T13:37:00"), true);
  assert.equal(m("*/15 9-17 * * 1-5", "2026-10-26T09:45:00"), true); // Monday
  assert.equal(m("*/15 9-17 * * 1-5", "2026-10-25T09:45:00"), false); // Sunday
  assert.equal(m("*/15 9-17 * * 1-5", "2026-10-26T18:00:00"), false);
  const c = parseCron("5/20 * * * *");
  assert.deepEqual([...c.minute], [5, 25, 45]);
});
test("Sunday is 0 or 7", () => {
  assert.equal(m("0 0 * * 7", "2026-10-25T00:00:00"), true);
  assert.equal(m("0 0 * * 0", "2026-10-25T00:00:00"), true);
});
test("both day fields restricted: either matches", () => {
  assert.equal(m("0 0 13 * 5", "2026-10-30T00:00:00"), true); // a Friday, not the 13th
  assert.equal(m("0 0 13 * 5", "2026-11-13T00:00:00"), true); // the 13th (also a Friday)
  assert.equal(m("0 0 13 * 5", "2026-10-29T00:00:00"), false);
});
test("one day field starred: both must match", () => {
  assert.equal(m("0 0 */2 * *", "2026-10-25T00:00:00"), true); // 25 is in 1,3,...
  assert.equal(m("0 0 */2 * *", "2026-10-24T00:00:00"), false);
  assert.equal(m("0 0 1 * *", "2026-10-25T00:00:00"), false);
});
test("a stepped day-of-month counts as starred, as in cron", () => {
  // "*/2" starts with "*", so both day fields must match.
  assert.equal(m("0 0 */2 * 1", "2026-10-26T00:00:00"), false); // Monday, even day
  assert.equal(m("0 0 */2 * 1", "2026-10-27T00:00:00"), false); // odd day, Tuesday
  assert.equal(m("0 0 */2 * 1", "2026-11-09T00:00:00"), true); // Monday, odd day
});
test("bad expressions are refused", () => {
  for (const e of [
    "60 * * * *",
    "* * * *",
    "* * * * * *",
    "a * * * *",
    "5-1 * * * *",
    "*/0 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "1,,2 * * * *",
  ]) {
    assert.throws(() => parseCron(e), Error, e);
  }
});
test("firstMatch: next minute, coalescing, window", () => {
  const c = parseCron("7 * * * *");
  const t = (s: string) => at(s).getTime();
  assert.equal(firstMatch(c, t("2026-10-25T13:06:30"), t("2026-10-25T13:07:00")), t("2026-10-25T13:07:00"));
  // Created at 13:07:30: this minute is already checked, so the next is 14:07.
  assert.equal(
    firstMatch(c, minuteOf(t("2026-10-25T13:07:30")), t("2026-10-25T14:07:00")),
    t("2026-10-25T14:07:00"),
  );
  // Three hours missed: the first missed firing is reported once.
  assert.equal(firstMatch(c, t("2026-10-25T13:00:00"), t("2026-10-25T16:00:00")), t("2026-10-25T13:07:00"));
  assert.equal(firstMatch(c, t("2026-10-25T13:08:00"), t("2026-10-25T14:06:00")), undefined);
  // Feb 31 never comes.
  const now = t("2026-10-25T13:00:00");
  assert.equal(firstMatch(parseCron("0 0 31 2 *"), now, now + 7 * 24 * 3600e3), undefined);
});
