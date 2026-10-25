// command-guard.ts: which commands need an OK, the settings, and the question.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import ext, { type Config, check, DEFAULTS, loadConfig } from "../extensions/command-guard.ts";
import { load } from "./guard-harness.ts";

const HOME = homedir();
const asks = (line: string, cfg: Config = DEFAULTS, cwd = HOME) => check(line, cwd, cfg);

test("the built-ins: recursive rm, sudo, deleting find", () => {
  for (const line of [
    "rm -rf ~/x",
    "rm -r x",
    "rm -R x",
    "rm --recursive x",
    "rm -fr x",
    "/bin/rm -rf x",
    "\\rm -rf x",
    "rm -rf /tmp",
    "rm -rf /tmp/ok ~/not",
    "rm -rf $DIR",
    "rm -rf -- -r",
  ]) {
    assert.deepEqual(asks(line), ["deletes recursively"], line);
  }
  for (const line of ["rm -f x", "rm x", "rmdir x", "ls -r"]) assert.deepEqual(asks(line), [], line);
  assert.deepEqual(asks("sudo ls"), ["runs as root"]);
  assert.deepEqual(asks("doas ls"), ["runs as root"]);
  assert.deepEqual(asks("sudo rm -rf ~/x"), ["runs as root", "deletes recursively"]);
  assert.deepEqual(asks("find . -name '*.o' -delete"), ["deletes the files find matches"]);
  assert.deepEqual(asks("find ~/x -exec rm {} \\;"), ["deletes the files find matches"]);
  assert.deepEqual(asks("find . -execdir /bin/rm -f {} +"), ["deletes the files find matches"]);
  assert.deepEqual(asks("find . -name x -print"), []);
  assert.deepEqual(asks("find . -name '*.log' -exec sudo rm -f {} \\;"), [
    "runs as root",
    "deletes the files find matches",
  ]);
  assert.deepEqual(asks("find . -exec sudo chmod 644 {} +"), ["runs as root"]);
  assert.deepEqual(asks("find . -exec echo {} \\; -delete"), ["deletes the files find matches"]);
  assert.deepEqual(asks("find . -exec echo {} \\; -exec sudo touch {} \\;"), ["runs as root"], "each -exec");
});

test("found wherever the shell would run it", () => {
  for (const line of [
    "true && rm -rf ~/x",
    "ls | xargs -0 rm -rf",
    "bash -c 'rm -rf ~/x'",
    'sh -c "cd ~ && rm -r x"',
    'eval "rm -rf ~/x"',
    "echo $(rm -rf ~/x)",
    "echo `rm -rf ~/x`",
    "bash <<'EOF'\nrm -rf ~/x\nEOF",
    "env FOO=1 rm -rf ~/x",
    "FOO=1 rm -rf ~/x",
    "timeout 5 rm -rf ~/x",
    "nice -n 5 rm -r ~/x",
    "(cd ~ && rm -rf x)",
    "if true; then rm -rf ~/x; fi",
    "for d in a b; do rm -rf ~/$d; done",
    "ionice -c 3 rm -rf ~/x",
    "ls | xargs --max-args 1 rm -rf",
    "function clean { rm -rf ~/x; }; clean",
  ]) {
    assert.ok(asks(line).includes("deletes recursively"), line);
  }
});

test("not fooled by text that only mentions a command", () => {
  for (const line of [
    'git commit -m "rm -rf x"',
    "echo 'sudo rm -rf /'",
    "cat > notes.md <<'EOF'\nrm -rf /\nsudo reboot\nEOF",
    "grep -r 'find . -delete' docs",
    "# rm -rf ~",
  ]) {
    assert.deepEqual(asks(line), [], line);
  }
});

test("temp directories need no OK, except their root", () => {
  const t = tmpdir();
  assert.deepEqual(asks("rm -rf /tmp/scratch /private/tmp/b"), []);
  assert.deepEqual(asks(`rm -rf "${t}/a b" ${t}/c*`), []);
  assert.deepEqual(asks("find /tmp/build -delete"), []);
  assert.deepEqual(asks("rm -rf /tmp/../etc"), ["deletes recursively"]);
  assert.deepEqual(asks("rm -rf /tmp/{x,../etc}"), ["deletes recursively"], "a brace expansion");
  assert.deepEqual(asks("rm -rf /tmp/x*/../../etc"), ["deletes recursively"], "climbing out after a glob");
  assert.deepEqual(asks(`rm -rf ${t}`), ["deletes recursively"]);
  // Relative targets count only when the session works in a temp directory and stays there.
  assert.deepEqual(asks("rm -rf build", DEFAULTS, "/tmp/work"), []);
  assert.deepEqual(asks("cd ~ && rm -rf build", DEFAULTS, "/tmp/work"), ["deletes recursively"]);
  assert.deepEqual(asks("rm -rf build"), ["deletes recursively"]);
  assert.deepEqual(
    asks("ls | xargs rm -rf", DEFAULTS, "/tmp/work"),
    ["deletes recursively"],
    "no operands, so the targets are unknown",
  );
  assert.deepEqual(
    asks("rm -rf $DIR", DEFAULTS, "/tmp/work"),
    ["deletes recursively"],
    "a variable could point anywhere",
  );
});

test("a symlink in a temp directory is judged by where it leads", () => {
  const dir = mkdtempSync(join(tmpdir(), "command-guard-"));
  try {
    symlinkSync(HOME, join(dir, "home"));
    assert.deepEqual(asks(`rm -rf ${dir}/home/not-yet-there`), ["deletes recursively"]);
    assert.deepEqual(asks(`rm -rf ${dir}/plain`), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rules: words in order, and one of the args", () => {
  const cfg: Config = {
    ...DEFAULTS,
    rules: [
      { command: "git reset", args: ["--hard"], reason: "discards uncommitted work" },
      { command: "git clean", args: ["-f", "--force"] },
      { command: "git push", args: ["--force", "-f"] },
      { command: "terraform destroy" },
    ],
  };
  assert.deepEqual(asks("git reset --hard", cfg), ["discards uncommitted work"]);
  assert.deepEqual(asks("git -C repo reset --hard HEAD~1", cfg), ["discards uncommitted work"]);
  assert.deepEqual(asks("git reset --soft HEAD~1", cfg), []);
  assert.deepEqual(asks('git commit -m "git reset --hard"', cfg), []);
  assert.deepEqual(asks("git clean -fd", cfg), ['matches the rule "git clean -f|--force"']);
  assert.deepEqual(asks("git clean -n", cfg), []);
  assert.deepEqual(asks("git push -f origin main", cfg), ['matches the rule "git push --force|-f"']);
  assert.deepEqual(asks("git push --force-with-lease", cfg), []);
  assert.deepEqual(asks("terraform destroy -auto-approve", cfg), ['matches the rule "terraform destroy"']);
  assert.deepEqual(asks("terraform plan", cfg), []);
});

test("builtins can be narrowed in the global settings", () => {
  const cfg = loadConfig(undefined, { builtins: ["sudo"] }).config;
  assert.deepEqual(asks("rm -rf ~/x", cfg), []);
  assert.deepEqual(asks("sudo ls", cfg), ["runs as root"]);
});

test("settings: a project can add but not remove", () => {
  assert.deepEqual(loadConfig(undefined, undefined), { config: DEFAULTS, problems: [] });
  const rule = { command: "git reset", args: ["--hard"] };
  // The merged view holds the project's lists, which replaced the global ones.
  const { config, problems } = loadConfig(
    { builtins: [], rules: [rule], timeoutSeconds: 1 },
    { rules: [{ command: "kubectl delete" }], timeoutSeconds: 60 },
  );
  assert.deepEqual(config.builtins, ["rm", "sudo", "find"]);
  assert.deepEqual(config.rules, [{ command: "kubectl delete" }, rule]);
  assert.equal(config.timeoutSeconds, 60);
  assert.deepEqual(problems, []);
  const bad = loadConfig(undefined, {
    builtins: ["rm", "dd"],
    rules: [{ command: "" }, { command: "x", args: "y" }, "z"],
    timeoutSeconds: -1,
  });
  assert.deepEqual(bad.config, { builtins: ["rm"], rules: [], timeoutSeconds: 120 });
  assert.equal(bad.problems.length, 5);
});

test("asks with a 2-minute timeout, and runs only on yes", async () => {
  let answer = true;
  const g = load(ext, { confirm: async () => answer });
  g.start();
  assert.equal(await g.call("bash", { command: "ls" }), undefined);
  assert.equal(await g.call("read", { path: "x" }), undefined);
  assert.equal(await g.call("bash", { command: "rm -rf ~/x" }), undefined);
  assert.equal(g.asked.length, 1);
  assert.equal(g.asked[0].opts.timeout, 120_000);
  assert.match(g.asked[0].title, /deletes recursively/);
  assert.equal(g.asked[0].message, "rm -rf ~/x");
  answer = false;
  const no = await g.call("bash", { command: "rm -rf ~/x" });
  assert.equal(no.block, true);
  assert.match(no.reason, /declined/);
});

test("no answer in time counts as a no", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const g = load(ext, {
      confirm: async (_t, _m, o) => {
        mock.timers.tick(o.timeout);
        return false;
      },
    });
    g.start();
    const r = await g.call("bash", { command: "sudo reboot" });
    assert.equal(r.block, true);
    assert.match(r.reason, /no answer within 120 s/);
  } finally {
    mock.timers.reset();
  }
});

test("refuses where nobody can be asked", async () => {
  const g = load(ext, { hasUI: false });
  g.start();
  const r = await g.call("bash", { command: "rm -rf ~/x" });
  assert.equal(r.block, true);
  assert.match(r.reason, /nobody can be asked/);
  assert.equal(g.asked.length, 0);
  assert.equal(await g.call("bash", { command: "rm -rf /tmp/scratch" }), undefined);
});

test("global settings are found where PI_CODING_AGENT_DIR points, ~ included", async () => {
  const home = mkdtempSync(join(tmpdir(), "command-guard-home-"));
  const saved = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR };
  try {
    mkdirSync(join(home, "agent"));
    writeFileSync(
      join(home, "agent", "settings.json"),
      JSON.stringify({ commandGuard: { builtins: ["sudo"] } }),
    );
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = "~/agent";
    const g = load(ext);
    await g.start();
    // Not ~/x: HOME is a temp directory here, which rm may clear without asking.
    assert.equal(
      await g.call("bash", { command: "rm -rf /opt/x" }),
      undefined,
      "the global settings dropped rm",
    );
    assert.equal(g.asked.length, 0);
  } finally {
    process.env.HOME = saved.home;
    process.env.PI_CODING_AGENT_DIR = saved.agent;
    rmSync(home, { recursive: true, force: true });
  }
});

test("bad settings are reported, not fatal", async () => {
  const g = load(ext, { settings: { commandGuard: { builtins: ["nope"] } } });
  g.start();
  assert.match(g.notes[0][1], /unknown builtin "nope"/);
});
