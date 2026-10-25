// Live test that loop.ts jobs survive a real /reload. It runs the extension
// beside a copy with the restore step removed: the copy must stop firing, which
// shows the reload really happened and the old runtime's timers are gone.
// About 3 minutes. Run by test/live.sh.
import fs from "node:fs";
import path from "node:path";
import { check, extensions, finish, here, rpc, sleep, text, ts } from "./live-rpc.mjs";

const real = path.join(extensions, "loop.ts");
const unrestored = path.join(extensions, "loop-unrestored.ts");
const RESTORE = "jobs.push({ ...j, checked: j.checked ?? minuteOf(now), due: j.due });";
const source = fs.readFileSync(real, "utf8");
if (source.split(RESTORE).length !== 2)
  throw new Error("the restore line is not in loop.ts exactly once; update RESTORE");
fs.writeFileSync(unrestored, source.replace(RESTORE, "void j;"));

async function run(name, ext) {
  const fires = [];
  const notes = [];
  const pi = rpc(name, { cwd: here, load: [ext, path.join(here, "reload-helper.ts")] }, (r) => {
    if (r.type === "message_end" && r.message?.role === "user" && text(r.message).startsWith("[loop ")) {
      fires.push(Date.now());
      console.log(`${ts()} [${name}] FIRE ${text(r.message).split("\n")[0]}`);
    }
    if (r.type === "extension_ui_request" && r.method === "notify") {
      notes.push(r.message);
      console.log(`${ts()} [${name}] notify: ${r.message.split("\n")[0]}`);
    }
  });
  const send = (message) => pi.send({ type: "prompt", message });
  await sleep(3000);
  send("/loop * * * * * Reply with exactly: tick");
  const deadline = Date.now() + 90000;
  while (fires.length < 1 && Date.now() < deadline) await sleep(250);
  if (fires.length < 1) {
    await pi.stop();
    console.log(`${ts()} [${name}] never fired`);
    return { reloaded: false, after: -1 };
  }
  await sleep(3000);
  send("/test-reload");
  await sleep(3000);
  const reloaded = notes.includes("session_start:reload");
  const n = fires.length;
  await sleep(Math.max(0, 60000 - (Date.now() % 60000)) + 65000); // two minute boundaries
  const after = fires.length - n;
  await pi.stop();
  console.log(`${ts()} [${name}] reloaded=${reloaded} firings after reload=${after}`);
  return { reloaded, after };
}

const [kept, lost] = await Promise.all([run("real", real), run("unrestored", unrestored)]);
check("reloaded, kept firing once a minute", kept.reloaded && kept.after === 2);
check(
  "without the restore nothing fires after reload, so the test sees reloads",
  lost.reloaded && lost.after === 0,
);
finish();
