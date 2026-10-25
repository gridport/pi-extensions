// secret-guard.ts: protected folders, redaction, settings, and the hooks.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import commandGuard from "../extensions/command-guard.ts";
import ext, {
  bashHit,
  DEFAULTS,
  type Filter,
  filterOutput,
  isSecretFile,
  loadConfig,
  MARK,
  protectedPath,
  redactLine,
  secretName,
} from "../extensions/secret-guard.ts";
import type { Placement } from "../src/pi-output.ts";
import { fakeSubagents, fixtures, load } from "./guard-harness.ts";

const F = DEFAULTS.folders;
const K = DEFAULTS.redactKeys;
const REMOVED = (n: number) => `[secret-guard: removed ${n} line(s) from protected folders]`;
const filter = (how: Filter) => (text: string, place?: Placement) => filterOutput(text, DEFAULTS, how, place);
// A secret file's text, grep lines, and output with protected lines dropped.
const secretText = filter({ protect: false, redact: "all" });
const grepLines = filter({ protect: false, redact: "matches" });
const drop = filter({ protect: true, redact: "matches" });

const HALF = 512 * 1024;
/** Lines of `n` bytes in all, n at least 100: `line` padded with x's, to 100 bytes but the last. */
const filler = (line: string, n: number) => {
  const count = Math.floor(n / 100) - 1;
  const lines = `${line.padEnd(99, "x")}\n`.repeat(count);
  return `${lines}${line.padEnd(n - count * 100 - 1, "x")}\n`;
};

/**
 * A bash output over 1 MiB, written to a pi-bash log, and codemode's copy of
 * it, as pi makes it from the log: the first and last half MiB around a marker.
 * The output is `head`, filler lines, `middle`, then `tail` and filler lines
 * that make up the last half MiB, so the copy resumes at `tail`.
 */
function longOutput(name: string, parts: { head: string; middle: string; tail: string; fill: string }) {
  const log = [
    parts.head,
    filler(parts.fill, 600_000 - Buffer.byteLength(parts.head)),
    parts.middle,
    parts.tail,
    filler(parts.fill, HALF - Buffer.byteLength(parts.tail)),
  ].join("");
  const path = join(root, `pi-bash-${name}.log`);
  writeFileSync(path, log);
  const bytes = Buffer.from(log);
  const copy = `${bytes.subarray(0, HALF)}\n\n[... ${bytes.length - 2 * HALF} bytes omitted ...]\n\n${parts.tail}${filler(parts.fill, HALF - Buffer.byteLength(parts.tail))}`;
  const lines = log.split("\n").length;
  const details = {
    truncation: { truncated: true, totalLines: lines, outputLines: 1 },
    fullOutputPath: path,
  };
  return { copy, details };
}
let root = "";
let savedHome: string | undefined;
before(() => {
  root = realpathSync(mkdtempSync(join(fixtures, "secret-guard-")));
  mkdirSync(join(root, "repo", "vault", "inner"), { recursive: true });
  mkdirSync(join(root, "repo", "private"));
  mkdirSync(join(root, "repo", "Secrets"));
  mkdirSync(join(root, "repo", "src"));
  // plain has no vault of its own, only one inside proj, and a file named vault.
  mkdirSync(join(root, "plain", "proj", "vault"), { recursive: true });
  mkdirSync(join(root, "plain", "bin"));
  writeFileSync(join(root, "plain", "bin", "vault"), "#!/bin/sh\n");
  mkdirSync(join(root, "home", "gnosis", "vault"), { recursive: true });
  writeFileSync(join(root, "repo", "vault", "secret.txt"), "x");
  writeFileSync(join(root, "repo", ".env"), "API_KEY=sk-live-1\n");
  symlinkSync(join(root, "repo", "vault"), join(root, "repo", "shortcut"));
  savedHome = process.env.HOME;
  process.env.HOME = join(root, "home");
});
after(() => {
  process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});
const repo = () => join(root, "repo");
const plain = () => join(root, "plain");

test("paths into a protected folder by name, and to an existing one", () => {
  const p = (path: string, cwd = repo(), folders = F) => protectedPath(path, cwd, folders);
  assert.equal(p("vault/a.csv"), "vault");
  assert.equal(p("vault/x", plain()), "vault", "a path into one counts by name, whatever it's relative to");
  assert.equal(p("vault"), "vault");
  assert.equal(p("./Vault/a"), "Vault");
  assert.equal(p("Secrets/a", repo(), ["secrets"]), "Secrets", "names match whatever their case");
  assert.equal(p("~/gnosis/vault/b"), "vault");
  assert.equal(p(`file://${repo()}/vault/a.pdf`), "vault");
  assert.equal(p(`file://${repo()}/%76ault/a.pdf`), "vault", "file URLs are decoded");
  assert.equal(p("notes/vault.md"), undefined);
  assert.equal(p("vaults/a"), undefined);
  assert.equal(p("a", join(repo(), "vault", "inner")), "vault", "the session works inside one");
  assert.equal(p("shortcut/secret.txt"), "vault", "a symlink into one");
  assert.equal(p("shortcut/new.txt"), "vault", "a symlink into one, to a file not there yet");
  assert.equal(p("vault", plain()), undefined, "the folder itself counts only where it exists");
  assert.equal(p("hashicorp/vault", plain()), undefined);
  assert.equal(p("bin/vault", plain()), undefined, "a file named vault is no folder");
  assert.equal(p("x", "/x", ["private"]), undefined);
  assert.equal(p("private/x", repo(), ["private"]), "private");
});

test("bash commands that name one", () => {
  const hit = (line: string, cwd = repo()) => bashHit(line, cwd, F);
  for (const line of [
    "cat vault/x",
    "cd vault && ls",
    "rg foo vault",
    "ls > vault/out",
    "cat --file=vault/x",
    "bash -c 'cat vault/x'",
    "echo $(cat vault/x)",
    "cat ~/gnosis/vault/a",
    "python3 <<'EOF'\nopen('vault/x').read()\nEOF",
    "cat <<'EOF' | python3\nopen('vault/x').read()\nEOF",
    `python3 -c "print(open('vault/secret.txt').read())"`,
    `node -e "require('fs').readFileSync('vault/x')"`,
    `node --eval "require('fs').readFileSync('vault/x')"`,
    "git show HEAD:vault/secret.txt",
    "cat shortcut/*",
    "cat {src,vault}/x",
    `python3.12 -c "print(open('vault/x').read())"`,
    `uv run python -c "print(open('vault/x').read())"`,
    `npx tsx -e "console.log(require('fs').readFileSync('vault/x', 'utf8'))"`,
  ]) {
    assert.equal(hit(line), "vault", line);
  }
  assert.equal(hit("sudo cat VAULT/x"), "VAULT");
  assert.equal(hit("ls", join(repo(), "vault")), "vault", "the session works inside one");
  assert.equal(hit("git show HEAD:vault/s.txt", join(repo(), "src")), "vault", "git paths are from the root");
  assert.equal(hit("cd proj && ls vault", plain()), "vault", "the folder itself, after a cd");
  assert.equal(hit("git -C proj ls-files vault", plain()), "vault", "the folder itself, under git -C");
  assert.equal(hit("pushd proj && ls vault", plain()), "vault", "the folder itself, after a pushd");
  assert.equal(hit("cd ~/gnosis && ls vault", plain()), "vault", "the folder itself, after cd ~/…");
  for (const line of [
    'git commit -m "add vault notes"',
    "cat > notes.md <<'EOF'\nsee vault/x\nEOF",
    "ls vaults",
    "cat my-vault.txt",
    "echo ok",
    "curl -s https://example.com/vault/x",
    "git clone git@github.com:hashicorp/vault.git",
  ]) {
    assert.equal(hit(line), undefined, line);
  }
  for (const line of [
    "vault status",
    "helm install vault hashicorp/vault",
    "git checkout feature/vault",
    "grep -rn vault src",
    "bin/vault status",
  ]) {
    assert.equal(hit(line, plain()), undefined, `${line}, where there is no vault folder`);
  }
});

test("many brace groups, as in quoted JSON, are checked in bounded time", async () => {
  // Sizes that take seconds without the limits, not forever, so the mutants finish.
  const rows = Array.from({ length: 11 }, (_, i) => `{"sku":"A${i}","name":"Item ${i}","qty":1,"ok":true}`);
  const json = `curl -s -X POST localhost:3000/api -H 'Content-Type: application/json' -d '{"items":[${rows}]}'`;
  const timed = async (what: string, run: () => unknown) => {
    const started = performance.now();
    await run();
    assert.ok(performance.now() - started < 500, `${what} took over 500 ms`);
  };
  const g = load(ext);
  await timed("JSON in a quoted word", async () =>
    assert.equal(await g.call("bash", { command: json }, plain()), undefined),
  );
  await timed("an unclosed group", () =>
    assert.equal(bashHit(`echo '{${"a,".repeat(50_000)}'`, plain(), F), undefined),
  );
  // A JSON array's expansions repeat most of their parts, each checked once.
  const many = Array.from({ length: 1000 }, (_, i) => `{"sku":"A${i}","name":"Item ${i}","qty":1}`);
  await timed("a 50 KB JSON array", () =>
    assert.equal(bashHit(`curl -d '[${many}]' localhost:3000/api`, plain(), F), undefined),
  );
  const over = "cat {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}/{src,vault}/x";
  assert.equal(bashHit(over, plain(), F), "vault", "a word over the limit still checks its first expansions");
});

test("filtering a command's output expands its words only when it names pi's log", async () => {
  // Expanding a 1 MB JSON body's words takes most of a second; without pi's log named, it isn't done.
  const rows = Array.from({ length: 40_000 }, (_, i) => `{"sku":"A${i}","qty":1}`);
  const command = `curl -s localhost:3000/api -d '{"items":[${rows}]}'`;
  const g = load(ext);
  await g.start(repo());
  const started = performance.now();
  assert.equal(g.result("bash", { command }, "ok"), undefined);
  assert.ok(performance.now() - started < 200, "a 1 MB command took over 200 ms");
});

test("a long line of URLs is redacted in bounded time", () => {
  // Compact JSON from a local API: every URL has a port, and no space follows.
  const items = Array.from(
    { length: 10_000 },
    (_, i) => `{"id":${i},"url":"http://localhost:3000/items/${i}"}`,
  );
  const started = performance.now();
  assert.equal(secretText(items.join(",")), items.join(","));
  assert.ok(performance.now() - started < 500, "a 570 KB line took over 500 ms");
});

test("a line of @ signs is redacted in bounded time", () => {
  // A hunk header's two runs of @ could split such a line in quadratically many ways.
  const line = "@".repeat(60_000);
  const started = performance.now();
  assert.equal(redactLine(line, K), line);
  assert.ok(performance.now() - started < 500, "a 60 KB line took over 500 ms");
});

test("a line of pi's log nested in itself is redacted in bounded time", () => {
  const line = `${"pi-bash-a.log:".repeat(80_000)}1: x`;
  const started = performance.now();
  assert.equal(grepLines(line), line);
  assert.ok(performance.now() - started < 500, "a 1.1 MB line took over 500 ms");
});

test("many END lines with no BEGIN are redacted in bounded time", () => {
  // Each drops the lines back to where a block could have started unseen.
  const ends = Array.from({ length: 100_000 }, () => "-----END RSA PRIVATE KEY-----").join("\n");
  const started = performance.now();
  assert.equal(secretText(ends), "");
  assert.ok(performance.now() - started < 500, "100,000 END lines took over 500 ms");
});

test("a secret file's diff section of many lines is redacted", async () => {
  const g = load(ext);
  await g.start(repo());
  const diff = `diff --git a/.env b/.env\n${"+API_KEY=sk\n".repeat(200_000)}`;
  const out = g.result("bash", { command: "git diff" }, diff).content[0].text;
  assert.equal(out, `diff --git a/.env b/.env\n${`+API_KEY=${MARK}\n`.repeat(200_000)}`);
});

test("settings: a project can add folders and keys but not remove them", () => {
  assert.deepEqual(loadConfig(undefined, undefined), DEFAULTS);
  const own = loadConfig(undefined, { folders: ["private"] });
  assert.deepEqual(own.folders, ["private"], "the global settings may replace a default");
  const merged = loadConfig({ folders: [], redactKeys: ["PIN"] }, undefined);
  assert.deepEqual(merged.folders, ["vault"]);
  assert.ok(merged.redactKeys.includes("PIN") && merged.redactKeys.includes("PASSWORD"));
  assert.deepEqual(loadConfig({ folders: "x" }, { folders: [1] }).folders, ["vault"], "bad values fall back");
  // pi's merged view holds the global entries too.
  assert.deepEqual(loadConfig({ folders: ["vault", "x"] }, { folders: ["vault"] }).folders, ["vault", "x"]);
});

test("secret names and files", () => {
  for (const n of [
    "API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "DB_PASSWORD",
    "DBPASSWORD",
    "APIKEY",
    "key",
    "SMTP_PASSWD",
    "GPG_PASSPHRASE",
    "private_key_path",
  ])
    assert.ok(secretName(n, K), n);
  for (const n of ["KEYBOARD", "MONKEY", "PATH", "PWD", "HOME", "NODE_ENV", "PUBLIC_URL", "PORT"])
    assert.ok(!secretName(n, K), n);
  for (const p of [".env", "app/.env.local", ".env.production", "prod.env", ".envrc"])
    assert.ok(isSecretFile(p, DEFAULTS), p);
  for (const p of ["env.ts", "environment.md", ".envoy", "src/env"]) assert.ok(!isSecretFile(p, DEFAULTS), p);
});

test("redaction", () => {
  assert.equal(redactLine("API_KEY=sk-live-1", K), `API_KEY=${MARK}`);
  assert.equal(redactLine('export GITHUB_TOKEN="ghp_x"', K), `export GITHUB_TOKEN=${MARK}`);
  assert.equal(redactLine('declare -x OPENAI_API_KEY="sk-abc"', K), `declare -x OPENAI_API_KEY=${MARK}`);
  assert.equal(redactLine('declare -x PATH="/bin"', K), 'declare -x PATH="/bin"');
  assert.equal(redactLine("password: hunter2", K), `password: ${MARK}`);
  assert.equal(redactLine("1:API_KEY=sk", K), `1:API_KEY=${MARK}`, "grep -n");
  assert.equal(redactLine("     1\tAPI_KEY=sk", K), `     1\tAPI_KEY=${MARK}`, "cat -n");
  assert.equal(
    redactLine("DATABASE_URL=postgres://app:hunter2@db:5432/x", K),
    `DATABASE_URL=postgres://app:${MARK}@db:5432/x`,
  );
  assert.equal(redactLine("CACHE=redis://:s3cret@cache:6379", K), `CACHE=redis://:${MARK}@cache:6379`);
  assert.equal(redactLine("DB=postgres://u:ab/cd@h/x", K), `DB=postgres://u:${MARK}@h/x`);
  // An access token, such as a signed JWT, runs to hundreds of characters.
  assert.equal(
    redactLine(`PIP_INDEX_URL=https://ci-bot:eyJ${"a".repeat(440)}@acme.jfrog.io/simple`, K),
    `PIP_INDEX_URL=https://ci-bot:${MARK}@acme.jfrog.io/simple`,
  );
  assert.equal(redactLine("MIRROR=http://user:@host/x", K), "MIRROR=http://user:@host/x", "no password");
  assert.equal(redactLine("PORT=5432", K), "PORT=5432");
  assert.equal(redactLine("EMPTY_SECRET=", K), "EMPTY_SECRET=");
  assert.equal(redactLine("# API_KEY=set me", K), "# API_KEY=set me");
  const pem = [
    "A=1",
    'TLS_CERT="-----BEGIN RSA PRIVATE KEY-----',
    "MIIEbase64",
    "morebase64",
    '-----END RSA PRIVATE KEY-----"',
    "B=2",
  ].join("\n");
  assert.equal(secretText(pem), ["A=1", `TLS_CERT=${MARK}`, "B=2"].join("\n"));
  assert.equal(secretText('K="-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"'), `K=${MARK}`);
  assert.equal(
    secretText("-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\nB=2"),
    `${MARK}\nB=2`,
  );
  assert.equal(
    secretText("K=-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----\nB=2"),
    `K=${MARK}\nB=2`,
    "a block on one line",
  );
  assert.equal(
    secretText("-----BEGIN PRIVATE KEY-----\nabcdef0123/AbC+d\nMIIE\n-----END PRIVATE KEY-----\nB=2"),
    `${MARK}\nB=2`,
    "a base64 line that looks like a commit line",
  );
  assert.equal(
    secretText(
      "diff --git a/.env b/.env\n@@ -1,4 +1,4 @@\n-----BEGIN PRIVATE KEY-----\nabcdef01/xyzQ\nMIIE\n-----END PRIVATE KEY-----\nB=2",
    ),
    `diff --git a/.env b/.env\n@@ -1,4 +1,4 @@\n${MARK}\nB=2`,
    "the same in a secret file's section, as --word-diff shows it, with no + or - in front",
  );
  assert.equal(
    drop("diff --git a/.env b/.env\n@@ -1 +1 @@\nadd more\nAPI_KEY=sk-1"),
    `diff --git a/.env b/.env\n@@ -1 +1 @@\nadd more\nAPI_KEY=${MARK}`,
    "a short word of hex letters, as --word-diff may show it, is no commit line",
  );
  assert.equal(
    grepLines(
      [
        ".env:3: API_KEY=abc",
        "app.py:3: API_KEY = os.environ['API_KEY']",
        ".env-4- PORT=1",
        "./.env:API_KEY=abc",
        ".env.local:TOKEN=t",
        "backups/2024-01-15/.env:3: API_KEY=x",
      ].join("\n"),
    ),
    [
      `.env:3: API_KEY=${MARK}`,
      "app.py:3: API_KEY = os.environ['API_KEY']",
      ".env-4- PORT=1",
      `./.env:API_KEY=${MARK}`,
      `.env.local:TOKEN=${MARK}`,
      `backups/2024-01-15/.env:3: API_KEY=${MARK}`,
    ].join("\n"),
  );
});

test("an END with no BEGIN drops lines back only to where a block could have opened unseen", () => {
  const end = "-----END RSA PRIVATE KEY-----";
  assert.equal(
    drop(`diff --git a/b.md b/b.md\n+ok\ndiff --git a/.env b/.env\n+${end}\n+B=3`),
    "diff --git a/b.md b/b.md\n+ok\ndiff --git a/.env b/.env\n+B=3",
    "back to its section's header",
  );
  assert.equal(
    secretText(`diff --git a/.env b/.env\n@@ -1 +1 @@\n+A=1\nabc1234f next\nB=2\n${end}`),
    "diff --git a/.env b/.env\n@@ -1 +1 @@\n+A=1\nabc1234f next",
    "back to the commit line that ended the section",
  );
});

test("a copy's placement counts only where it fits the copy", () => {
  const none = new Map<number, string>();
  assert.equal(
    drop("diff --git a/vault/t.txt b/vault/t.txt\n+A1\n+A2", {
      before: [],
      parts: none,
      omission: { at: 1, before: [] },
    }),
    REMOVED(3),
    "no marker where the omission is",
  );
  assert.equal(
    secretText("unrelated", { before: [], parts: new Map([[0, "API_KEY=sk"]]) }),
    "unrelated",
    "a line given as part of a line it isn't in",
  );
});

test("lines and git diffs naming a path into a protected folder are dropped", () => {
  assert.equal(
    drop("a.md:1: x\nvault/s.txt:1: secret\nb.md:2: see vault.md\nmyvault/x:1: y"),
    `a.md:1: x\nb.md:2: see vault.md\nmyvault/x:1: y\n${REMOVED(1)}`,
  );
  assert.equal(drop("./Vault/t:2: y"), REMOVED(1));
  assert.equal(drop(`${repo()}/vault/s.txt`), REMOVED(1));
  assert.equal(drop("nothing here"), "nothing here");
  assert.equal(drop("total 0\nvault"), "total 0\nvault", "the folder's name alone");
  const diff = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "    update",
    "diff --git a/vault/secret.txt b/vault/secret.txt",
    "index 1111111..2222222 100644",
    "--- a/vault/secret.txt",
    "+++ b/vault/secret.txt",
    "@@ -1 +1 @@",
    "-old",
    "+TOPSECRET-4711",
    "commit 89abcdef0123456789abcdef0123456789abcdef",
    "    next",
    "diff --git a/README.md b/README.md",
    "@@ -1 +1 @@",
    "+hello",
  ].join("\n");
  assert.equal(
    drop(diff),
    [
      "commit 0123456789abcdef0123456789abcdef01234567",
      "    update",
      "commit 89abcdef0123456789abcdef0123456789abcdef",
      "    next",
      "diff --git a/README.md b/README.md",
      "@@ -1 +1 @@",
      "+hello",
      REMOVED(7),
    ].join("\n"),
  );
  const merge = [
    "diff --cc vault/secret.txt",
    "deleted file mode 100644",
    "index 1111111,2222222..3333333",
    "++TOPSECRET-4711",
    "0123abc a --oneline commit",
    "diff --git a/b.md b/b.md",
    "+ok",
  ].join("\n");
  assert.equal(
    drop(merge),
    ["0123abc a --oneline commit", "diff --git a/b.md b/b.md", "+ok", REMOVED(4)].join("\n"),
  );
  assert.equal(
    drop("+A2\n+A3\ndiff --git a/b.md b/b.md\n+ok", {
      before: ["diff --git a/vault/t.txt b/vault/t.txt", "+A1"],
      parts: new Map(),
    }),
    `diff --git a/b.md b/b.md\n+ok\n${REMOVED(2)}`,
    "text that starts inside a section",
  );
});

test("a secret file's diff is redacted, even when the command doesn't name it", async () => {
  const g = load(ext);
  await g.start(repo());
  const diff = [
    "diff --git a/.env.production b/.env.production",
    "index 1a2b3c4..5d6e7f8 100644",
    "--- a/.env.production",
    "+++ b/.env.production",
    "@@ -1,3 +1,3 @@ STRIPE_SECRET=sk_ctx",
    " PORT=80",
    "-API_KEY=sk-old",
    "+API_KEY=sk-new",
    "diff --git a/docs/setup.md b/docs/setup.md",
    "+API_KEY=your-key-here",
  ];
  // A hunk header's context, which git takes from a line before the hunk, is left out.
  const want = [
    ...diff.slice(0, 4),
    "@@ -1,3 +1,3 @@",
    " PORT=80",
    `-API_KEY=${MARK}`,
    `+API_KEY=${MARK}`,
    ...diff.slice(8),
  ];
  assert.equal(g.result("bash", { command: "git diff" }, diff.join("\n")).content[0].text, want.join("\n"));
  // pi shows a long output's tail, here from inside the section, and the model reads its file from an offset.
  const log = join(root, "pi-bash-5e5e.log");
  writeFileSync(log, diff.join("\n"));
  const details = { truncation: { truncated: true, totalLines: 10, outputLines: 6 }, fullOutputPath: log };
  const notice = `[Showing lines 5-10 of 10. Full output: ${log}]`;
  const tail = g.result(
    "bash",
    { command: "git diff" },
    `${diff.slice(4).join("\n")}\n\n${notice}`,
    undefined,
    details,
  );
  assert.equal(tail.content[0].text, `${want.slice(4).join("\n")}\n\n${notice}`);
  const read = g.result("read", { path: log, offset: 5, limit: 4 }, diff.slice(4, 8).join("\n"));
  assert.equal(read.content[0].text, want.slice(4, 8).join("\n"));
  // The section's lines without its header, as grep, sed or tail of pi's file shows them.
  const hunk = "@@ -1,3 +1,3 @@ STRIPE_SECRET";
  for (const [tool, input, out, redacted] of [
    [
      "grep",
      { pattern: "^@@", path: log },
      `pi-bash-5e5e.log:5: ${hunk}=sk_ctx`,
      `pi-bash-5e5e.log:5: ${hunk}=${MARK}`,
    ],
    ["bash", { command: `grep -n '^@@' ${log}` }, `5:${hunk}=sk_ctx`, `5:${hunk}=${MARK}`],
    [
      "bash",
      { command: `sed -n 5,8p ${log}` },
      diff.slice(4, 8).join("\n"),
      [`${hunk}=${MARK}`, ...want.slice(5, 8)].join("\n"),
    ],
  ] as const)
    assert.equal(g.result(tool, input, out).content[0].text, redacted, JSON.stringify(input));
  // A command that names the file, in diff's other formats.
  for (const [command, out, redacted] of [
    [
      "diff .env .env.bak",
      "1c1\n< API_KEY=a\n---\n> API_KEY=b",
      `1c1\n< API_KEY=${MARK}\n---\n> API_KEY=${MARK}`,
    ],
    [
      "diff -u .env .env.bak",
      "--- .env\n+++ .env.bak\n@@ -1 +1 @@\n-API_KEY=a\n+API_KEY=b",
      `--- .env\n+++ .env.bak\n@@ -1 +1 @@\n-API_KEY=${MARK}\n+API_KEY=${MARK}`,
    ],
    [
      "diff -c .env .env.bak",
      "*** .env\n--- .env.bak\n***************\n*** 1 ****\n! API_KEY=a\n--- 1 ----\n! API_KEY=b",
      `*** .env\n--- .env.bak\n***************\n*** 1 ****\n! API_KEY=${MARK}\n--- 1 ----\n! API_KEY=${MARK}`,
    ],
  ])
    assert.equal(g.result("bash", { command }, out).content[0].text, redacted, command);
  // git quotes a path with a non-ASCII character, escaped in octal.
  const quoted = 'diff --git "a/donn\\303\\251es/.env" "b/donn\\303\\251es/.env"';
  const quotedVault = 'diff --git "vault/donn\\303\\251es.txt" "vault/donn\\303\\251es.txt"';
  for (const [out, want] of [
    [`${quoted}\n+API_KEY=sk`, `${quoted}\n+API_KEY=${MARK}`],
    [`${quotedVault}\n+A1`, REMOVED(2)],
  ])
    assert.equal(g.result("bash", { command: "git diff --no-prefix" }, out).content[0].text, want);
  // A merge's combined diff: two marker columns, and @@@.
  const merge = "diff --cc .env\n@@@ -1,2 -1,2 +1,2 @@@ STRIPE_SECRET=sk_ctx\n++API_KEY=sk-merged";
  assert.equal(
    g.result("bash", { command: "git log -p -1" }, merge).content[0].text,
    `diff --cc .env\n@@@ -1,2 -1,2 +1,2 @@@\n++API_KEY=${MARK}`,
  );
  // Its hunk line grepped from pi's file, with no header in view.
  assert.equal(
    g.result("bash", { command: `grep -n '^@@@' ${log}` }, "2:@@@ -1,2 -1,2 +1,2 @@@ STRIPE_SECRET=sk_ctx")
      .content[0].text,
    `2:@@@ -1,2 -1,2 +1,2 @@@ STRIPE_SECRET=${MARK}`,
  );
});

test("a private-key block is dropped, though only part of it shows", async () => {
  const g = load(ext, { settings: { secretGuard: { redactFiles: ["*.pem"] } } });
  await g.start(repo());
  const shown = (tool: string, input: Record<string, unknown>, out: string, details?: unknown) =>
    g.result(tool, input, out, undefined, details)?.content?.[0].text ?? out;
  const [begin, end] = ["-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"];
  const env = ["A=1", `PRIVATE_KEY="${begin}`, "MIIEbody1", "MIIEbody2", `${end}"`, "B=2"];
  const file = join(repo(), ".env.key");
  writeFileSync(file, env.join("\n"));
  // A read from an offset inside the block, and a command that prints its end.
  assert.equal(shown("read", { path: file, offset: 3, limit: 2 }, env.slice(2, 4).join("\n")), "");
  assert.equal(shown("bash", { command: `tail -n 3 ${file}` }, env.slice(3).join("\n")), "B=2");
  // pi's tail of a long output that ends inside the block, and the model reading pi's file from inside it.
  const log = join(root, "pi-bash-c0de.log");
  writeFileSync(log, env.slice(0, 4).join("\n"));
  const details = { truncation: { truncated: true, totalLines: 4, outputLines: 2 }, fullOutputPath: log };
  const notice = `[Showing lines 3-4 of 4. Full output: ${log}]`;
  const tail = `${env.slice(2, 4).join("\n")}\n\n${notice}`;
  assert.equal(shown("bash", { command: `head -n 4 ${file}` }, tail, details), `\n\n${notice}`);
  assert.equal(shown("read", { path: log, offset: 3 }, env.slice(2, 4).join("\n")), "");
  // codemode's copy starts at the head.
  const copy = g.result(
    "bash",
    { command: `head -n 4 ${file}` },
    tail,
    { output: env.slice(0, 4).join("\n") },
    details,
  );
  assert.equal(copy.structuredContent.output, `A=1\nPRIVATE_KEY=${MARK}`);

  // A secret file's diff: a new key file; a later hunk after one that ended
  // inside a key; a section that ends inside one; and a change after a key,
  // whose hunk starts inside it. git takes a hunk header's context from a line
  // before the hunk, which may be inside a key.
  const diff = [
    "diff --git a/k.pem b/k.pem",
    "--- /dev/null",
    "+++ b/k.pem",
    "@@ -0,0 +1,4 @@",
    `+${begin}`,
    "+MIIEbody1",
    "+MIIEbody2",
    `+${end}`,
    "diff --git a/.env.prod b/.env.prod",
    "@@ -1,2 +1,2 @@",
    `-PRIVATE_KEY="${begin}`,
    `+PRIVATE_KEY="${begin}`,
    "@@ -20,2 +20,2 @@ MIIEbody9",
    "-C=1",
    "+C=2",
    "@@ -30 +30 @@",
    `+KEY2="${begin}`,
    "diff --git a/.env b/.env",
    "--- a/.env",
    "+++ b/.env",
    "@@ -3,3 +3,3 @@ MIIEbody1",
    " MIIEbody2",
    ` ${end}"`,
    "-B=2",
    "+B=3",
    "diff --git a/README.md b/README.md",
    "+hello",
  ];
  const want = [
    ...diff.slice(0, 4),
    `+${MARK}`,
    ...diff.slice(8, 10),
    `-PRIVATE_KEY=${MARK}`,
    "@@ -20,2 +20,2 @@",
    "-C=1",
    "+C=2",
    "@@ -30 +30 @@",
    `+KEY2=${MARK}`,
    ...diff.slice(17, 20),
    "@@ -3,3 +3,3 @@",
    "-B=2",
    "+B=3",
    ...diff.slice(25),
  ];
  assert.equal(shown("bash", { command: "git diff" }, diff.join("\n")), want.join("\n"));
  // pi's file of it, read from inside a key in one section; the next section's lines are kept.
  const keys = join(root, "pi-bash-c0df.log");
  writeFileSync(keys, diff.join("\n"));
  assert.equal(shown("read", { path: keys, offset: 6, limit: 2 }, diff.slice(5, 7).join("\n")), "");
  assert.equal(
    shown("read", { path: keys, offset: 6, limit: 5 }, diff.slice(5, 10).join("\n")),
    diff.slice(8, 10).join("\n"),
  );
  // The same, inside a protected file's section.
  const vault = [
    "diff --git a/vault/k.txt b/vault/k.txt",
    `+${begin}`,
    "+MIIEbody1",
    `+${end}`,
    ...diff.slice(25),
  ];
  writeFileSync(keys, vault.join("\n"));
  assert.equal(
    shown("read", { path: keys, offset: 3 }, vault.slice(2).join("\n")),
    [...diff.slice(25), REMOVED(2)].join("\n"),
  );
});

test("codemode's copy resumes inside a secret file's section that opens in the part it leaves out", async () => {
  const g = load(ext);
  await g.start(repo());
  // codemode's copy as the guard leaves it, unchanged if it returns nothing.
  const copyOf = (command: string, out: { copy: string; details: unknown }) =>
    g.result("bash", { command }, "x", { output: out.copy, truncated: true }, out.details)?.structuredContent
      .output ?? out.copy;
  // The tail starts partway through a line, whose name it cuts off; what's
  // left looks like a commit line. Its whole line, in pi's log, has the name.
  const diff = longOutput("c0e0", {
    head: "diff --git a/b.md b/b.md\n",
    middle: "diff --git a/.env b/.env\n+API_KEY_",
    tail: "0ab1c2d3=tok-1\n+PASSWORD=pw-2\ndiff --git a/c.md b/c.md\n",
    fill: "+ok",
  });
  assert.equal(
    copyOf("git diff", diff),
    diff.copy.replace("\n0ab1c2d3=tok-1\n+PASSWORD=pw-2\n", `\n${MARK}\n+PASSWORD=${MARK}\n`),
  );
  // A command that prints a secret file, with no diff in it, cuts off a name the same way.
  const env = longOutput("c0e1", {
    head: "PORT=80\n",
    middle: "API_KEY_",
    tail: "0ab1c2d3=tok-1\n",
    fill: "X=1",
  });
  assert.equal(copyOf("cat .env", env), env.copy.replace("\n0ab1c2d3=tok-1\n", `\n${MARK}\n`));
  // A line whose whole line holds no secret is kept as it is.
  const plain = longOutput("c0e2", {
    head: "PORT=80\n",
    middle: "NOTE_",
    tail: "0ab1c2d3=hello\n",
    fill: "X=1",
  });
  assert.equal(copyOf("cat .env", plain), plain.copy);
  // A tail cut just before a newline starts with what is left of its line: nothing.
  const end = longOutput("c0e3", { head: "PORT=80\n", middle: "API_KEY=sk-1", tail: "\nX=2\n", fill: "X=1" });
  assert.equal(copyOf("cat .env", end), end.copy.replace("]\n\n\nX=2\n", `]\n\n${MARK}\nX=2\n`));
});

test("an END with no BEGIN in codemode's tail drops back no further than the part left out", async () => {
  const g = load(ext);
  await g.start(repo());
  const copyOf = (out: { copy: string; details: unknown }) =>
    g.result("bash", { command: "git log -p" }, "x", { output: out.copy, truncated: true }, out.details)
      ?.structuredContent.output ?? out.copy;
  const tail = " MIIEtail1\n -----END PRIVATE KEY-----\n";
  // A hunk in the part left out, where the block may have opened: the head stays.
  const left = longOutput("d0e0", {
    head: "diff --git a/.env b/.env\n@@ -1,3 +1,3 @@\n+A=1\n",
    middle: "@@ -9000,5 +9000,5 @@\n MIIEmiddle\n",
    tail,
    fill: " ok",
  });
  assert.equal(copyOf(left), left.copy.replace(tail, ""));
  // None there: the block may have opened anywhere after the head's hunk, so
  // the head's lines after it go too, but not pi's marker.
  const head = longOutput("d0e1", {
    head: "diff --git a/.env b/.env\n@@ -1,3 +1,3 @@\n",
    middle: " MIIEmiddle\n",
    tail,
    fill: " MIIEfill",
  });
  const marker = /\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\n/.exec(head.copy)?.[0];
  assert.equal(copyOf(head), `diff --git a/.env b/.env\n@@ -1,3 +1,3 @@${marker}${head.copy.split(tail)[1]}`);
});

test("a tail of one long line is judged by the whole line", async () => {
  const g = load(ext);
  await g.start(repo());
  const value = "7".repeat(60_000);
  const log = join(root, "pi-bash-1013.log");
  const notice = `[Showing last 48.8KB of line 2 (line is 58.6KB). Full output: ${log}]`;
  const details = {
    truncation: { truncated: true, totalLines: 2, outputLines: 1, lastLinePartial: true },
    fullOutputPath: log,
  };
  for (const [command, output] of [
    ["cat .env", `PORT=80\nAPI_KEY=${value}`],
    ["git diff", `diff --git a/.env b/.env\n+API_KEY=${value}`],
  ]) {
    writeFileSync(log, output);
    const tail = `${value.slice(10_000)}\n\n${notice}`;
    assert.equal(
      g.result("bash", { command }, tail, undefined, details).content[0].text,
      `${MARK}\n\n${notice}`,
    );
  }
});

test("a part of a line over 1 MiB, too long to judge, is the mark", async () => {
  const g = load(ext);
  await g.start(repo());
  const log = join(root, "pi-bash-1014.log");
  const notice = `[Showing last 48.8KB of line 2 (line is 1.0MB). Full output: ${log}]`;
  const details = {
    truncation: { truncated: true, totalLines: 2, outputLines: 1, lastLinePartial: true },
    fullOutputPath: log,
  };
  const tail = (command: string, first: string, line: string) => {
    writeFileSync(log, `${first}\n${line}`);
    const text = `${line.slice(-50_000)}\n\n${notice}`;
    return g.result("bash", { command }, text, undefined, details)?.content[0].text;
  };
  const x = "x".repeat(1024 * 1024 + 1);
  // A plain line, a secret file's, and one that names a protected path.
  assert.equal(tail("ls", "1", x), `${MARK}\n\n${notice}`);
  assert.equal(tail("cat .env", "1", `NOTE=${x}`), `${MARK}\n\n${notice}`);
  assert.equal(tail("ls", "1", `vault/a ${x}`), `${MARK}\n\n${notice}`);
  // A line inside a private key is dropped, as ever.
  assert.equal(tail("cat .env", "-----BEGIN PRIVATE KEY-----", x), `\n\n${notice}`);
  // A line of 1 MiB is judged.
  assert.equal(tail("ls", "1", x.slice(1)), undefined);
});

test("output the guard can't filter is withheld, since pi would pass it on unfiltered", async () => {
  const g = load(ext);
  await g.start(repo());
  for (const [thrown, why] of [
    [new Error("unreadable"), "Error"],
    [Object.assign(new Error("too long"), { code: "ERR_STRING_TOO_LONG" }), "ERR_STRING_TOO_LONG"],
    ["unreadable", "string"],
  ]) {
    const details = {
      get fullOutputPath(): string {
        throw thrown;
      },
    };
    const out = g.result(
      "bash",
      { command: "cat .env" },
      "API_KEY=sk-1",
      { output: "API_KEY=sk-1" },
      details,
    );
    const text = `[secret-guard: withheld this output, which it could not filter (${why})]`;
    assert.deepEqual(out, { content: [{ type: "text", text }] }, why);
  }
});

test("a line that only looks like codemode's omission marker leaves nothing out", async () => {
  const g = load(ext);
  await g.start(repo());
  const marker = "[... 9 bytes omitted ...]";
  const bash = (command: string, out: string) =>
    g.result("bash", { command }, out, { output: out, truncated: false });
  const vault = bash(
    "git diff",
    `${marker}\ndiff --git a/vault/t.txt b/vault/t.txt\n+A1\ndiff --git a/b.md b/b.md\n+ok`,
  );
  const kept = `${marker}\ndiff --git a/b.md b/b.md\n+ok\n${REMOVED(2)}`;
  assert.equal(vault.content[0].text, kept);
  assert.equal(vault.structuredContent.output, kept);
  const env = bash("git diff", `${marker}\ndiff --git a/.env b/.env\n+API_KEY=tok-1`);
  assert.equal(env.structuredContent.output, `${marker}\ndiff --git a/.env b/.env\n+API_KEY=${MARK}`);
  const cat = bash("cat .env", `${marker}\nNOTE=hello\nAPI_KEY=tok-1`);
  assert.equal(
    cat.structuredContent.output,
    `${marker}\nNOTE=hello\nAPI_KEY=${MARK}`,
    "a whole line follows",
  );
  const read = g.result("read", { path: join(repo(), ".env") }, `${marker}\nNOTE=hello`);
  assert.equal(read, undefined);
});

test("a protected diff section cut off before its header is still dropped", async () => {
  const g = load(ext);
  await g.start(repo());
  const lines = [
    "diff --git a/vault/t.txt b/vault/t.txt",
    "@@ -0,0 +1,3 @@",
    "+A1",
    "+A2",
    "+A3",
    "diff --git a/b.md b/b.md",
    "+ok",
  ];
  const log = join(root, "pi-bash-0123456789abcdef.log");
  writeFileSync(log, lines.join("\n"));
  const details = { truncation: { truncated: true, totalLines: 7, outputLines: 4 }, fullOutputPath: log };
  // pi shows long bash output's tail, here from +A2.
  const notice = `[Showing lines 4-7 of 7. Full output: ${log}]`;
  const tail = g.result(
    "bash",
    { command: "git diff" },
    `${lines.slice(3).join("\n")}\n\n${notice}`,
    undefined,
    details,
  );
  assert.equal(tail.content[0].text, `diff --git a/b.md b/b.md\n+ok\n${REMOVED(2)}\n\n${notice}`);
  // codemode's copy of output over 1 MiB keeps a head and a tail around an omission.
  const long = longOutput("0123", {
    head: "diff --git a/b.md b/b.md\n",
    middle: "diff --git a/vault/t.txt b/vault/t.txt\n+A1\n",
    tail: "+A3\ndiff --git a/c.md b/c.md\n",
    fill: "+ok",
  });
  const both = g.result(
    "bash",
    { command: "git diff" },
    "x",
    { output: long.copy, truncated: true },
    long.details,
  );
  assert.equal(both.structuredContent.output, `${long.copy.replace("\n+A3\n", "\n")}\n${REMOVED(1)}`);
  // The model reads the rest of the log in chunks.
  const chunk = g.result("read", { path: log, offset: 4 }, lines.slice(3).join("\n"));
  assert.equal(chunk.content[0].text, `diff --git a/b.md b/b.md\n+ok\n${REMOVED(2)}`);
});

test("cut-off output resumes inside a section opened on its last hidden line, whatever pi reports", async () => {
  const g = load(ext);
  await g.start(repo());
  const lines = [
    "diff --git a/b.md b/b.md",
    "+ok",
    "diff --git a/vault/t.txt b/vault/t.txt",
    "+A1",
    "+A2",
    "diff --git a/c.md b/c.md",
    "+fine",
  ];
  const log = join(root, "pi-bash-aaaa.log");
  writeFileSync(log, lines.join("\n"));
  const tail = lines.slice(3).join("\n");
  // What the model is shown of a result: the guard's text, or the output unchanged.
  const shown = (tool: string, input: Record<string, unknown>, out: string, details?: unknown) =>
    g.result(tool, input, out, undefined, details)?.content?.[0].text ?? out;
  const hidden = (text: string) => {
    assert.doesNotMatch(text, /\+A[12]/);
    assert.match(text, /c\.md/);
  };
  const details = { truncation: { truncated: true, totalLines: 7, outputLines: 4 }, fullOutputPath: log };
  const notice = `[Showing lines 4-7 of 7. Full output: ${log}]`;
  hidden(shown("bash", { command: "git diff" }, `${tail}\n\n${notice}`, details));
  // A command that timed out or was aborted ends in an error, whose result keeps
  // only the text: details are empty, and pi's notice says what was cut.
  for (const n of [notice, `[Showing lines 4-7 of 7 (50.0KB limit). Full output: ${log}]`]) {
    hidden(
      shown("bash", { command: "git diff" }, `${tail}\n\n${n}\n\nCommand timed out after 5 seconds`, {}),
    );
  }
  // The output may print a notice of its own; pi's comes last.
  const fake = `[Showing lines 1-4 of 4. Full output: ${log}]`;
  hidden(shown("bash", { command: "git diff" }, `${fake}\n${tail}\n\n${notice}\n\nCommand aborted`, {}));
  const long = join(root, "pi-bash-bbbb.log");
  writeFileSync(long, "diff --git a/vault/k b/vault/k\n+SECRET-LONG-LINE");
  const partial = `LONG-LINE\n\n[Showing last 9B of line 2 (line is 17B). Full output: ${long}]\n\nCommand aborted`;
  assert.doesNotMatch(
    shown("bash", { command: "git diff" }, partial, {}),
    /LONG-LINE/,
    "a partial last line",
  );
  hidden(shown("read", { path: log, offset: 4 }, tail));
  // codemode's tail starts partway through a line, here one that looks like a commit line.
  const over = longOutput("cccc", {
    head: "diff --git a/b.md b/b.md\n",
    middle: "diff --git a/vault/t.txt b/vault/t.txt\n+dead",
    tail: "0123abcd A1\n+A2\ndiff --git a/c.md b/c.md\n",
    fill: "+ok",
  });
  const copy = g.result(
    "bash",
    { command: "git diff" },
    "x",
    { output: over.copy, truncated: true },
    over.details,
  );
  assert.doesNotMatch(copy.structuredContent.output, /A1|A2/, "a partial first line after the omission");
  assert.match(copy.structuredContent.output, /c\.md/);
});

test("pi's notice and status lines stay when the output ends inside a protected section", async () => {
  const g = load(ext);
  await g.start(repo());
  // git sorts paths, so a long diff often ends in vault/.
  const log = join(root, "pi-bash-eeee.log");
  writeFileSync(log, "diff --git a/b.md b/b.md\n+ok\ndiff --git a/vault/s.txt b/vault/s.txt\n+S1\n+S2");
  const details = { truncation: { truncated: true, totalLines: 5, outputLines: 2 }, fullOutputPath: log };
  const notice = `[Showing lines 4-5 of 5. Full output: ${log}]`;
  const shown = (r: any) => r?.content[0].text ?? "(unchanged)";
  assert.equal(
    shown(
      g.result(
        "bash",
        { command: "git diff; exit 3" },
        `+S1\n+S2\n\n${notice}\n\nCommand exited with code 3`,
        undefined,
        details,
      ),
    ),
    `${REMOVED(2)}\n\n${notice}\n\nCommand exited with code 3`,
  );
  assert.equal(
    shown(
      g.result(
        "bash",
        { command: "git diff" },
        `+S1\n+S2\n\n${notice}\n\nCommand timed out after 5 seconds`,
        undefined,
        {},
      ),
    ),
    `${REMOVED(2)}\n\n${notice}\n\nCommand timed out after 5 seconds`,
  );
  for (const hint of [
    "[Showing lines 4-5 of 9. Use offset=6 to continue.]",
    "[Showing lines 4-5 of 9 (50.0KB limit). Use offset=6 to continue.]",
    "[4 more lines in file. Use offset=6 to continue.]",
  ]) {
    assert.equal(
      shown(g.result("read", { path: log, offset: 4 }, `+S1\n+S2\n\n${hint}`)),
      `${REMOVED(2)}\n\n${hint}`,
    );
  }
  // A notice the output prints, with pi's lines below it, isn't pi's.
  const printed = `${notice}\n+S1\n\nCommand aborted`;
  assert.equal(g.result("bash", { command: "cat notes.md" }, printed, undefined, {}), undefined);
  // pi's own notice comes last, after any the output's last lines look like.
  const decoy = `[Showing lines 1-5 of 5. Full output: ${join(root, "pi-bash-ffff.log")}]`;
  const status = "Command terminated without an exit code";
  assert.equal(
    shown(
      g.result(
        "bash",
        { command: "git diff" },
        `+S1\n+S2\n\n${decoy}\n\n${notice}\n\n${status}`,
        undefined,
        {},
      ),
    ),
    `${REMOVED(2)}\n\n${decoy}\n\n${notice}\n\n${status}`,
  );
  // Each of pi's lines is one line: a block that only looks like one is output.
  for (const fake of [
    "[Showing lines 1-2 of 3 (\nAPI_KEY=sk-real\n). Use offset=4 to continue.]",
    `[Showing lines 1-2 of 3 (\nAPI_KEY=sk-real\n). Full output: ${log}]`,
    `[Showing last 1B of line 3 (line is \nAPI_KEY=sk-real\n). Full output: ${log}]`,
  ]) {
    const out = `A=1\n\n${fake}`;
    assert.doesNotMatch(g.result("bash", { command: "cat .env" }, out)?.content[0].text ?? out, /sk-real/);
  }
  // A notice is followed only to pi's own file of the full output.
  const notes = join(root, "notes.txt");
  writeFileSync(notes, "diff --git a/vault/s.txt b/vault/s.txt\n+S1");
  const other = `+fine\n\n[Showing lines 2-2 of 2. Full output: ${notes}]\n\nCommand aborted`;
  assert.equal(g.result("bash", { command: "make" }, other, undefined, {}), undefined);
});

test("pi's log of a command that prints secrets is redacted, whatever reads it", async () => {
  const g = load(ext);
  await g.start(repo());
  const full = "OPENAI_API_KEY=sk-live-123\nDB_PASSWORD=hunter2\n1\n2\n3";
  const log = join(root, "pi-bash-abab.log");
  writeFileSync(log, full);
  const details = { truncation: { truncated: true, totalLines: 5, outputLines: 3 }, fullOutputPath: log };
  g.result("bash", { command: "cat .env && seq 1 3" }, "1\n2\n3", undefined, details);
  assert.equal(readFileSync(log, "utf8"), full, "pi's file is left as pi wrote it");
  const hint = "[2 more lines in file. Use offset=4 to continue.]";
  assert.equal(
    g.result("read", { path: log, limit: 3 }, `OPENAI_API_KEY=sk-live-123\nDB_PASSWORD=hunter2\n1\n\n${hint}`)
      .content[0].text,
    `OPENAI_API_KEY=${MARK}\nDB_PASSWORD=${MARK}\n1\n\n${hint}`,
  );
  // Code that sets a token looks like a secret, so bash and grep aren't refused; what they print is redacted.
  const printed = "OPENAI_API_KEY=sk-live-123\nok";
  for (const command of [
    `head -3 ${log}`,
    `cd ${root} && tail pi-bash-abab.log`,
    "tail $TMPDIR/pi-bash-abab.log",
    "python3 tool.py --input=pi-bash-abab.log",
    `python3 -c "print(open('${log}').read())"`,
  ]) {
    assert.equal(await g.call("bash", { command }), undefined, command);
    assert.equal(
      g.result("bash", { command }, printed).content[0].text,
      `OPENAI_API_KEY=${MARK}\nok`,
      command,
    );
  }
  assert.equal(
    g.result("bash", { command: "tail notes.log" }, printed),
    undefined,
    "a file that isn't pi's log",
  );
  for (const path of [log, root]) {
    assert.equal(await g.call("grep", { pattern: "KEY", path }), undefined, path);
    assert.equal(
      g.result("grep", { pattern: "KEY", path }, "pi-bash-abab.log:1: OPENAI_API_KEY=sk-live-123").content[0]
        .text,
      `pi-bash-abab.log:1: OPENAI_API_KEY=${MARK}`,
      path,
    );
  }
  // The log may hold an earlier grep's or cat -n's lines, each with its own prefix under the new one.
  for (const [line, want] of [
    [
      "pi-bash-abab.log:1501: ./.env:3:API_KEY=sk-live-123",
      `pi-bash-abab.log:1501: ./.env:3:API_KEY=${MARK}`,
    ],
    // .env.local, not .env, since *.env would also match a prefix such as "1502: .env".
    [
      "pi-bash-abab.log:1502: .env.local:3:API_KEY=sk-live-123",
      `pi-bash-abab.log:1502: .env.local:3:API_KEY=${MARK}`,
    ],
    ["pi-bash-abab.log-1503- 3:DB_PASSWORD=hunter2", `pi-bash-abab.log-1503- 3:DB_PASSWORD=${MARK}`],
    [
      "pi-bash-abab.log-1505- .env.local-4-DB_PASSWORD=hunter2",
      `pi-bash-abab.log-1505- .env.local-4-DB_PASSWORD=${MARK}`,
    ],
    [
      "pi-bash-abab.log:1504:      4\tSTRIPE_SECRET=sk_9",
      `pi-bash-abab.log:1504:      4\tSTRIPE_SECRET=${MARK}`,
    ],
  ])
    assert.equal(g.result("grep", { pattern: "KEY", path: log }, line).content[0].text, want, line);
  for (const [command, out, want] of [
    [`grep -n PASSWORD ${log}`, "1502:3:DB_PASSWORD=hunter2", `1502:3:DB_PASSWORD=${MARK}`],
    [`grep -H KEY ${log}`, `${log}:./.env:3:API_KEY=sk`, `${log}:./.env:3:API_KEY=${MARK}`],
    [`cat -n ${log}`, "  1503\t     4\tSTRIPE_SECRET=sk_9", `  1503\t     4\tSTRIPE_SECRET=${MARK}`],
  ])
    assert.equal(g.result("bash", { command }, out).content[0].text, want, command);
});

test("a project's redactFiles can't switch off the filtering of pi's log", async () => {
  const g = load(ext, { settings: { secretGuard: { redactFiles: ["*.log"] } } });
  await g.start(repo());
  const log = join(root, "pi-bash-eeee.log");
  const full = "diff --git a/vault/t.txt b/vault/t.txt\n+A1\ndiff --git a/c.md b/c.md\n+fine";
  writeFileSync(log, full);
  assert.doesNotMatch(g.result("read", { path: log }, full).content[0].text, /A1/);
});

test("pi's log of a protected diff can be read only with read", async () => {
  const g = load(ext);
  await g.start(repo());
  const log = join(root, "pi-bash-cccc.log");
  writeFileSync(log, "diff --git a/vault/t.txt b/vault/t.txt\n+A1\n+A2\ndiff --git a/c.md b/c.md\n+fine");
  const clean = join(root, "pi-bash-dddd.log");
  writeFileSync(clean, "diff --git a/c.md b/c.md\n+fine");
  for (const [tool, input] of [
    ["bash", { command: `sed -n 2,5p ${log}` }],
    ["bash", { command: `tail -n 3 < ${log}` }],
    ["bash", { command: `python3 -c "print(''.join(open('${log}').readlines()[1:]))"` }],
    ["bash", { command: `python3 tool.py --input=${log}` }],
    ["grep", { pattern: "A", path: log }],
  ] as const) {
    const r = await g.call(tool, input);
    assert.equal(r?.block, true, `${tool} ${JSON.stringify(input)}`);
    assert.match(r.reason, /read tool/);
  }
  assert.equal(await g.call("read", { path: log, offset: 2 }), undefined);
  assert.equal(
    await g.call("bash", { command: `tail -n 3 ${clean}` }),
    undefined,
    "a log with no such section",
  );
  const diff = join(root, "changes.diff");
  writeFileSync(diff, "diff --git a/vault/t.txt b/vault/t.txt\n+A1");
  assert.equal(await g.call("bash", { command: `cat ${diff}` }), undefined, "a file that isn't pi's log");
});

test("tool calls into a protected folder are refused", async () => {
  const g = load(ext);
  await g.start(repo());
  for (const [tool, input] of [
    ["read", { path: "vault/secret.txt" }],
    ["read", { path: "@vault/secret.txt" }],
    ["grep", { pattern: "x", path: "@vault" }],
    ["ls", { path: "vault" }],
    ["grep", { pattern: "x", path: "vault" }],
    ["find", { pattern: "*", path: "shortcut" }],
    ["edit", { path: "vault/a", oldText: "a", newText: "b" }],
    ["write", { path: "vault/a", content: "b" }],
    ["write", { path: "shortcut/new.txt", content: "b" }],
    ["bash", { command: "cat vault/secret.txt" }],
    ["browser_navigate", { url: `file://${repo()}/vault/secret.txt` }],
    ["mcp_tool", { options: { files: ["vault/x", "y"] } }],
  ] as const) {
    const r = await g.call(tool, input as Record<string, unknown>);
    assert.equal(r?.block, true, `${tool} ${JSON.stringify(input)}`);
    assert.match(r.reason, /protected folder/);
  }
  for (const [tool, input] of [
    ["read", { path: "README.md" }],
    ["grep", { pattern: "x" }],
    ["bash", { command: "ls" }],
    ["subagent", { task: "Never read vault/ files." }],
    ["browser_navigate", { url: "https://example.com/vault/x" }],
    ["web_search", { query: "configure hashicorp/vault" }],
  ] as const) {
    assert.equal(
      await g.call(tool, input as Record<string, unknown>),
      undefined,
      `${tool} ${JSON.stringify(input)}`,
    );
  }
  assert.equal(
    await g.call("bash", { command: "vault status" }, plain()),
    undefined,
    "no vault folder there",
  );
});

test("a redacted value can't be written back into a secret file", async () => {
  const g = load(ext);
  await g.start(repo());
  const refused = [
    ["write", { path: ".env", content: `API_KEY=${MARK}\n` }],
    ["edit", { path: "app/.env", edits: [{ oldText: "A=1", newText: `A=${MARK}` }] }],
    ["bash", { command: `cat > .env <<'EOF'\nAPI_KEY=${MARK}\nEOF` }],
    ["bash", { command: `echo "K=${MARK}" >> .env.local` }],
  ] as const;
  for (const [tool, input] of refused) {
    const r = await g.call(tool, input as Record<string, unknown>);
    assert.equal(r?.block, true, JSON.stringify(input));
    assert.match(r.reason, /stands for a secret/);
  }
  for (const [tool, input] of [
    ["write", { path: "notes.md", content: `values show as ${MARK}` }],
    ["bash", { command: `git commit -m "redact as ${MARK}"` }],
    ["bash", { command: "cat .env" }],
    ["write", { path: ".env", content: "API_KEY=new-value\n" }],
  ] as const) {
    assert.equal(await g.call(tool, input as Record<string, unknown>), undefined, JSON.stringify(input));
  }
});

test("tool output is filtered and redacted", async () => {
  const g = load(ext);
  await g.start(repo());
  const text = (tool: string, input: Record<string, unknown>, out: string) =>
    g.result(tool, input, out)?.content[0].text ?? out;
  const env = "API_KEY=sk-live-1\nPORT=80";
  assert.equal(text("read", { path: ".env" }, env), `API_KEY=${MARK}\nPORT=80`);
  assert.equal(text("read", { path: "@.env.local" }, env), `API_KEY=${MARK}\nPORT=80`, "pi drops the @");
  const crlf = "API_KEY=sk-live-1\r\nPORT=80\r\n";
  assert.equal(text("read", { path: ".env" }, crlf), `API_KEY=${MARK}\r\nPORT=80\r\n`, "CRLF line endings");
  assert.equal(text("bash", { command: "cat .env" }, crlf), `API_KEY=${MARK}\r\nPORT=80\r\n`);
  assert.equal(text("bash", { command: "grep -r KEY ." }, "./.env:API_KEY=sk\r"), `./.env:API_KEY=${MARK}\r`);
  assert.equal(
    text(
      "read",
      { path: ".env" },
      "CERT=-----BEGIN PRIVATE KEY-----MIIEv\r\nab\r\n-----END PRIVATE KEY-----\r\nX=1\r\n",
    ),
    `CERT=${MARK}\r\nX=1\r\n`,
    "a key block opened inline on a CRLF line",
  );
  for (const value of ["sk\r", "ab\rcd", "ab\u{2028}cd"])
    assert.equal(text("read", { path: ".env" }, `API_KEY=${value}\r\nX=1`), `API_KEY=${MARK}\r\nX=1`, value);
  assert.equal(text("bash", { command: "cat < .env" }, env), `API_KEY=${MARK}\nPORT=80`);
  assert.equal(text("bash", { command: "git show HEAD:.env.production" }, env), `API_KEY=${MARK}\nPORT=80`);
  assert.equal(text("bash", { command: "git show main:.envrc" }, env), `API_KEY=${MARK}\nPORT=80`);
  assert.equal(
    text("bash", { command: "grep -r -C1 TOKEN ." }, "./.env-2-SECRET_TOKEN=abc"),
    `./.env-2-SECRET_TOKEN=${MARK}`,
    "a context line",
  );
  assert.equal(g.result("read", { path: "README.md" }, env), undefined, "other files are left alone");
  assert.equal(text("bash", { command: "cat .env" }, env), `API_KEY=${MARK}\nPORT=80`);
  assert.equal(
    text("bash", { command: "cat .env*" }, env),
    `API_KEY=${MARK}\nPORT=80`,
    "a glob that matches one",
  );
  assert.equal(text("bash", { command: "cat -n .env" }, "     1\tAPI_KEY=sk"), `     1\tAPI_KEY=${MARK}`);
  assert.equal(text("bash", { command: "grep -n API_KEY .env" }, "1:API_KEY=sk"), `1:API_KEY=${MARK}`);
  assert.equal(text("bash", { command: "grep -r API_KEY ." }, "./.env:API_KEY=sk"), `./.env:API_KEY=${MARK}`);
  assert.equal(
    text("bash", { command: "grep API_KEY .env app.py" }, ".env:API_KEY=sk\napp.py:API_KEY = env('API_KEY')"),
    `.env:API_KEY=${MARK}\napp.py:API_KEY = env('API_KEY')`,
  );
  assert.equal(text("bash", { command: "rg --hidden API_KEY" }, ".env:API_KEY=sk"), `.env:API_KEY=${MARK}`);
  assert.equal(
    text("bash", { command: "env" }, "HOME=/h\nGITHUB_TOKEN=ghp_1"),
    `HOME=/h\nGITHUB_TOKEN=${MARK}`,
  );
  assert.equal(text("bash", { command: "printenv | sort" }, "OPENAI_API_KEY=sk"), `OPENAI_API_KEY=${MARK}`);
  assert.equal(
    text("bash", { command: "printenv OPENAI_API_KEY" }, "sk-abc\n"),
    `${MARK}\n`,
    "printenv prints only the value",
  );
  assert.equal(
    text("read", { path: ".env" }, "VAULT=vault/x"),
    "VAULT=vault/x",
    "a secret file's line naming a protected path",
  );
  assert.equal(text("bash", { command: "printenv HOME" }, "/h"), "/h");
  assert.equal(
    text("bash", { command: "declare -p" }, 'declare -x OPENAI_API_KEY="sk-abc"\ndeclare -x PATH="/bin"'),
    `declare -x OPENAI_API_KEY=${MARK}\ndeclare -x PATH="/bin"`,
  );
  assert.equal(text("bash", { command: "set" }, "OPENAI_API_KEY=sk-abc"), `OPENAI_API_KEY=${MARK}`);
  assert.equal(
    text("bash", { command: "set -e && cat compose.yml" }, "POSTGRES_PASSWORD: pw"),
    "POSTGRES_PASSWORD: pw",
    "set with options lists nothing",
  );
  assert.equal(
    text("bash", { command: "declare -p OPENAI_API_KEY" }, 'declare -x OPENAI_API_KEY="sk-abc"'),
    `declare -x OPENAI_API_KEY=${MARK}`,
    "declare -p prints the value",
  );
  assert.equal(
    text("bash", { command: "export" }, 'declare -x OPENAI_API_KEY="sk-abc"'),
    `declare -x OPENAI_API_KEY=${MARK}`,
    "export alone lists them",
  );
  assert.equal(
    text("bash", { command: "rg KEY" }, ".env:1: API_KEY=sk\nvault/s:1: KEY=v\napp.py:2: KEY = 1"),
    `.env:1: API_KEY=${MARK}\napp.py:2: KEY = 1\n${REMOVED(1)}`,
  );
  assert.equal(text("grep", { pattern: "x" }, "vault/s:1: x\nok.md:1: x"), `ok.md:1: x\n${REMOVED(1)}`);
  assert.equal(text("find", { pattern: "*.txt" }, "a.txt\nvault/secret.txt"), `a.txt\n${REMOVED(1)}`);
  assert.equal(
    text("read", { path: join(tmpdir(), "pi-bash-0123456789abcdef.log") }, "vault/s:1: KEY=v\nok"),
    `ok\n${REMOVED(1)}`,
    "pi's file of a long bash command's full output",
  );
  assert.equal(g.result("bash", { command: "ls" }, "a\nb"), undefined, "unchanged output is left alone");
});

test("structured content is filtered too, even when the text needs nothing", async () => {
  const g = load(ext);
  await g.start(repo());
  // bash shows the model only the tail, but codemode scripts get the whole output.
  const r = g.result("bash", { command: "rg KEY" }, "tail ok", {
    output: "vault/s:1: KEY=v\nok",
    exit_code: 0,
  });
  assert.equal(r.content, undefined, "the text is left as it was");
  assert.deepEqual(r.structuredContent, { output: `ok\n${REMOVED(1)}`, exit_code: 0 });
  const both = g.result("bash", { command: "cat .env" }, "API_KEY=sk", { output: "API_KEY=sk" });
  assert.equal(both.content[0].text, `API_KEY=${MARK}`);
  assert.deepEqual(both.structuredContent, { output: `API_KEY=${MARK}` }, "kept along with the new text");
});

test("subagents load both guards, through the one registration a session gets", async () => {
  const subagents = await fakeSubagents();
  const path = (name: string) =>
    realpathSync(fileURLToPath(new URL(`../extensions/${name}.ts`, import.meta.url)));
  try {
    const secret = load(ext);
    const command = load(commandGuard);
    await secret.start(repo());
    assert.deepEqual(subagents.registered(), [{ id: "secret-guard", path: path("secret-guard") }]);
    await command.start(repo());
    assert.deepEqual(subagents.registered(), [
      { id: "secret-guard", path: path("secret-guard") },
      { id: "command-guard", path: path("command-guard") },
    ]);
    secret.stop();
    assert.deepEqual(subagents.registered(), [{ id: "command-guard", path: path("command-guard") }]);
    command.stop();
    assert.deepEqual(subagents.registered(), []);
    assert.deepEqual([...secret.notes, ...command.notes], []);
  } finally {
    subagents.remove();
  }
});

test("another extension's registration is left alone, and a guard that couldn't join is not kept", async () => {
  const subagents = await fakeSubagents();
  try {
    const other = subagents.register("test-session", [{ id: "other", path: "/x/other.ts" }]);
    const secret = load(ext);
    await secret.start(repo());
    assert.match(secret.notes[0]?.[1] ?? "", /subagents will not load this guard: .*already registered/);
    assert.deepEqual(subagents.registered(), [{ id: "other", path: "/x/other.ts" }]);
    other.dispose();
    const command = load(commandGuard);
    await command.start(repo());
    assert.deepEqual(
      subagents.registered().map((e) => e.id),
      ["command-guard"],
    );
    command.stop();
    secret.stop();
  } finally {
    subagents.remove();
  }
});

test("custom folders replace the default", async () => {
  const g = load(ext, { settings: { secretGuard: { folders: ["private"] } } });
  await g.start(repo());
  // The merged settings came from a project here, so vault stays protected too.
  assert.equal((await g.call("read", { path: "private/a" }))?.block, true);
  assert.equal((await g.call("read", { path: "vault/a" }))?.block, true);
});
