// Live tests of loop.ts: three sessions in parallel, each firing a cheap model
// every minute. About 5 minutes. Run by test/live.sh; ONLY=p1,p3 picks
// scenarios.
import path from "node:path";
import { check, extensions, finish, here, rpc, sleep, text, ts } from "./live-rpc.mjs";

const T0 = Date.now();

function start(name, extra = []) {
  const s = { name, events: [], firings: [], notes: [] };
  const load = [path.join(extensions, "loop.ts"), path.join(here, "reload-helper.ts")];
  const pi = rpc(name, { cwd: here, load, extra }, (r) => {
    r._t = Date.now();
    s.events.push(r);
    if (r.type === "message_end" && r.message?.role === "user") {
      const t = text(r.message);
      if (t.startsWith("[loop ")) {
        s.firings.push({ t: r._t, head: t.split("\n")[0], body: t });
        console.log(
          `${ts()} [${name}] FIRE ${t.split("\n")[0]} :: ${t.split("\n").slice(2).join(" ").slice(0, 60)}`,
        );
      } else console.log(`${ts()} [${name}] user: ${t.slice(0, 80)}`);
    } else if (r.type === "message_end" && r.message?.role === "assistant") {
      const tc = (r.message.content || [])
        .filter((c) => c.type === "toolCall")
        .map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 120)})`);
      console.log(
        `${ts()} [${name}] assistant: ${text(r.message).slice(0, 80)} ${tc.join(" ")} ${r.message.stopReason ?? ""} ${r.message.errorMessage ?? ""}`,
      );
    } else if (r.type === "message_end" && r.message?.role === "toolResult") {
      console.log(
        `${ts()} [${name}] toolResult(${r.message.toolName}${r.message.isError ? " ERROR" : ""}): ${text(r.message).replace(/\n/g, " | ").slice(0, 200)}`,
      );
    } else if (r.type === "extension_ui_request" && r.method === "notify") {
      s.notes.push({ t: r._t, type: r.notifyType, msg: r.message });
      console.log(
        `${ts()} [${name}] notify(${r.notifyType}): ${r.message.replace(/\n/g, " | ").slice(0, 200)}`,
      );
    } else if (r.type === "response" && !r.success) {
      console.log(`${ts()} [${name}] response FAILED ${r.command}: ${r.error}`);
    } else if (/error/i.test(r.type)) {
      console.log(`${ts()} [${name}] ${r.type}: ${JSON.stringify(r).slice(0, 300)}`);
    }
  });
  s.prompt = (message) => pi.send({ type: "prompt", message });
  s.waitFor = async (pred, ms, label) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await sleep(250);
    }
    console.log(`${ts()} [${name}] timeout waiting for ${label}`);
    return false;
  };
  s.settledAfter = (t) => s.events.some((e) => e.type === "agent_settled" && e._t > t);
  s.stop = pi.stop;
  return s;
}
const dueOf = (f) => /due (\S+ \S+)\]/.exec(f.head)?.[1];

async function p1() {
  const s = start("p1");
  await sleep(3000);
  s.prompt("/loop * * * * * Reply with exactly: tick");
  await s.waitFor(() => s.notes.some((n) => n.msg.startsWith("Armed")), 10000, "armed");
  s.prompt("/loop */5 * * * * Reply with exactly: tick");
  await s.waitFor(() => s.notes.some((n) => n.type === "error"), 10000, "dup refusal");
  check(
    "p1 duplicate prompt refused",
    s.notes.some((n) => n.type === "error" && /already sends this prompt/.test(n.msg)),
  );
  await s.waitFor(() => s.firings.length >= 2 && s.settledAfter(s.firings[1].t), 160000, "2 firings");
  check(
    "p1 fires every minute",
    s.firings.length >= 2 &&
      s.firings[1].t - s.firings[0].t > 40000 &&
      s.firings[1].t - s.firings[0].t < 80000,
    `${s.firings.length} firings`,
  );
  const before = s.firings.length;
  s.prompt("/test-reload");
  await sleep(3000);
  await s.waitFor(
    () => s.firings.length >= before + 2 && s.settledAfter(s.firings.at(-1).t),
    160000,
    "2 firings after reload",
  );
  const after = s.firings.slice(before);
  check("p1 survives reload", after.length >= 2, `${after.length} after reload`);
  const dues = s.firings.map(dueOf);
  check("p1 no minute fired twice", new Set(dues).size === dues.length, dues.join(", "));
  s.prompt("/loop delete all");
  await sleep(2000);
  const n = s.firings.length;
  await sleep(75000);
  check("p1 delete stops firing", s.firings.length === n, `${s.firings.length - n} after delete`);
  s.prompt("/loop");
  await sleep(1500);
  check("p1 list empty", s.notes.at(-1)?.msg === "No loop jobs.");
  await s.stop();
}

async function p2() {
  const s = start("p2");
  await sleep(3000);
  s.prompt("/loop * * * * * Reply with exactly: tock");
  await s.waitFor(() => s.notes.some((n) => n.msg.startsWith("Armed")), 10000, "armed");
  // Wait for the first firing to settle, then go busy across two minute boundaries.
  await s.waitFor(() => s.firings.length >= 1 && s.settledAfter(s.firings[0].t), 90000, "first firing");
  const busyStart = Date.now();
  s.prompt("Use the bash tool to run exactly `sleep 140`, then reply with exactly: slept");
  await sleep(2000);
  await s.waitFor(() => s.settledAfter(busyStart + 100000), 220000, "busy run settles");
  const busyEnd = s.events.filter((e) => e.type === "agent_settled" && e._t > busyStart)[0]?._t;
  await sleep(8000);
  const during = s.firings.filter((f) => f.t > busyStart && f.t < busyEnd);
  const rightAfter = s.firings.filter((f) => f.t >= busyEnd && f.t < busyEnd + 8000);
  check("p2 nothing sent while busy", during.length === 0, `${during.length}`);
  check(
    "p2 one coalesced firing after settle",
    rightAfter.length === 1,
    rightAfter.map((f) => f.head).join(" ; "),
  );
  if (rightAfter[0]) {
    const due = new Date(dueOf(rightAfter[0]).replace(" ", "T")).getTime();
    check(
      "p2 coalesced firing names first missed minute",
      due > busyStart && due < busyStart + 62000,
      dueOf(rightAfter[0]),
    );
  }
  const n = s.firings.length;
  await s.waitFor(() => s.firings.length > n, 75000, "firing resumes");
  check("p2 resumes the normal schedule", s.firings.length > n);
  s.prompt("/loop delete all");
  await sleep(1500);
  await s.stop();
}

async function p3() {
  const s = start("p3");
  await sleep(3000);
  s.prompt(
    'Call the loop tool once with action "create", cron "* * * * *", prompt "Reply with exactly: once", recurring false. Then reply with exactly: ok',
  );
  await s.waitFor(() => s.firings.length >= 1 && s.settledAfter(s.firings[0].t), 150000, "one-shot firing");
  check("p3 model armed a one-shot that fired", s.firings.length === 1 && /once/.test(s.firings[0].body));
  await sleep(70000);
  check("p3 one-shot fired only once", s.firings.length === 1, `${s.firings.length}`);
  s.prompt("/loop 7 3 * * * Reply with exactly: nightly");
  await s.waitFor(() => s.notes.some((n) => n.msg.startsWith("Armed")), 10000, "armed nightly");
  await sleep(1000);
  await s.stop();
  const r = start("p3", ["-c"]);
  await r.waitFor(() => r.notes.length > 0, 15000, "restart notice");
  check(
    "p3 restart reports the lapsed job",
    r.notes.some((n) => n.type === "warning" && /not armed/.test(n.msg) && /7 3 \* \* \*/.test(n.msg)),
  );
  r.prompt("/loop");
  await sleep(1500);
  check("p3 nothing armed after restart", r.notes.at(-1)?.msg === "No loop jobs.");
  await r.stop();
  const r2 = start("p3", ["-c"]);
  await sleep(5000);
  check("p3 lapse reported only once", !r2.notes.some((n) => n.type === "warning"), JSON.stringify(r2.notes));
  await r2.stop();
}

const pick = (process.env.ONLY || "p1,p2,p3").split(",");
await Promise.all([p1, p2, p3].filter((f) => pick.includes(f.name)).map((f) => f()));
finish(` in ${Math.round((Date.now() - T0) / 1000)}s`);
