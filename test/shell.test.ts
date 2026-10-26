// The shell splitter both guards use: how it splits a command line.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandsOf, pathsOf } from "../src/shell.ts";

const words = (line: string) => commandsOf(line).map((c) => c.words);

test("operators, quotes and escapes", () => {
  assert.deepEqual(words(`a 1 && b "2 3" || c '4;5' | d; e & f`), [
    ["a", "1"],
    ["b", "2 3"],
    ["c", "4;5"],
    ["d"],
    ["e"],
    ["f"],
  ]);
  assert.deepEqual(words(`\\rm -rf x\ny # comment`), [["rm", "-rf", "x"], ["y"]]);
  assert.deepEqual(words(`echo "a \\"b\\" c" d\\ e`), [["echo", 'a "b" c', "d e"]]);
});

test("redirections are not arguments", () => {
  const [c] = commandsOf(`cat a 2>&1 > out.txt < in.txt &>> log`);
  assert.deepEqual(c.words, ["cat", "a"]);
  assert.deepEqual(c.redirects, ["out.txt", "in.txt", "log"]);
});

test("here-documents are data unless a shell runs them", () => {
  const data = commandsOf(`cat > f.md <<'EOF'\nrm -rf /\nEOF\nnext`);
  assert.deepEqual(
    data.map((c) => c.words),
    [["cat"], ["next"]],
  );
  assert.equal(data[0].heredocs[0], "rm -rf /");
  assert.deepEqual(words(`bash <<-EOF\n\trm -rf ~/x\n\tEOF`), [["bash"], ["rm", "-rf", "~/x"]]);
});

test("substitutions, bash -c and eval are looked into", () => {
  assert.deepEqual(words(`echo $(rm -rf ~/a) "$(ls b)" \`pwd\``).slice(0, 3), [
    ["rm", "-rf", "~/a"],
    ["ls", "b"],
    ["pwd"],
  ]);
  assert.deepEqual(words(`sudo bash -lc 'git status; rm -r y'`).slice(1), [
    ["git", "status"],
    ["rm", "-r", "y"],
  ]);
  assert.deepEqual(words(`eval "rm -rf z"`).slice(1), [["rm", "-rf", "z"]]);
});

test("what echo or a here-document pipes into a shell is looked into", () => {
  assert.deepEqual(words(`cat <<'EOF' | bash\nrm -rf x\nEOF`), [["cat"], ["bash"], ["rm", "-rf", "x"]]);
  assert.deepEqual(words(`echo -n 'rm -rf y' | sudo sh`).slice(2), [["rm", "-rf", "y"]]);
  assert.deepEqual(words(`printf 'rm -rf z' | bash`).slice(2), [["rm", "-rf", "z"]]);
  assert.deepEqual(words(`echo 'rm -rf x' | grep rm`), [
    ["echo", "rm -rf x"],
    ["grep", "rm"],
  ]);
  assert.deepEqual(words(`echo 'rm -rf x' || bash`), [["echo", "rm -rf x"], ["bash"]], "|| is no pipe");
});

test("keywords before a command are stripped", () => {
  const run = (line: string) => commandsOf(line).map((c) => c.argv);
  assert.deepEqual(run("if true; then rm -rf x; fi"), [["true"], ["rm", "-rf", "x"], ["fi"]]);
  assert.deepEqual(run("while read f; do rm -r $f; done"), [["read", "f"], ["rm", "-r", "$f"], ["done"]]);
});

test("wrappers are stripped", () => {
  const [c] = commandsOf("FOO=1 sudo -u me env -i BAR=2 timeout 5 xargs -0 -n 1 /bin/rm -rf");
  assert.deepEqual(c.argv, ["/bin/rm", "-rf"]);
  assert.equal(c.name, "rm");
  assert.deepEqual(c.wrappers, ["sudo", "env", "timeout", "xargs"]);
  assert.equal(commandsOf("FOO=1")[0].name, "", "nothing runs");
  const run = (line: string) => commandsOf(line)[0].argv;
  assert.deepEqual(run("ionice -c 3 rm x"), ["rm", "x"], "an option whose value is the next word");
  assert.deepEqual(run("stdbuf -o L rm x"), ["rm", "x"]);
  assert.deepEqual(run("doas -u me rm x"), ["rm", "x"]);
  assert.deepEqual(run("sudo --user me rm x"), ["rm", "x"], "a long option, too");
  assert.deepEqual(run("xargs --max-args 1 rm x"), ["rm", "x"]);
  assert.deepEqual(run("timeout --signal KILL 5 rm x"), ["rm", "x"]);
  assert.deepEqual(run("env -iC / rm x"), ["rm", "x"], "a cluster that ends in one");
  assert.deepEqual(run("xargs -tn 1 rm x"), ["rm", "x"]);
  assert.deepEqual(run("sudo -uroot rm x"), ["rm", "x"], "a value inside the cluster");
  const chdir = (line: string) => commandsOf(line)[0].chdir;
  assert.ok(chdir("env -iC /x rm y") && chdir("env --chdir=/x rm y") && chdir("sudo -D /x rm y"));
  assert.ok(!chdir("env -i rm y") && !chdir("sudo -C 3 rm y") && !chdir("rm -C y"), "nor its own options");
});

test("a function's body is looked into", () => {
  const run = (line: string) => commandsOf(line).map((c) => c.argv);
  assert.deepEqual(run("function clean { rm -rf x; }; clean")[0], ["rm", "-rf", "x"]);
  assert.deepEqual(run("clean() { rm -rf x; }; clean")[1], ["rm", "-rf", "x"]);
});

test("the code an interpreter runs", () => {
  const code = (line: string) => commandsOf(line).at(-1)?.code;
  assert.deepEqual(code(`python3 -c 'print(1)'`), ["print(1)"]);
  assert.deepEqual(code(`python -uc 'print(1)'`), ["print(1)"], "a code flag that ends a cluster");
  assert.deepEqual(code(`perl -ne 'print' f`), ["print"]);
  assert.deepEqual(code(`node -p 'x'`), ["x"]);
  assert.deepEqual(code(`node --eval 'x'`), ["x"]);
  assert.deepEqual(code(`node --eval='x'`), ["x"]);
  assert.deepEqual(code(`deno eval 'x'`), ["x"]);
  assert.deepEqual(code(`python3.12 -c 'x'`), ["x"]);
  assert.deepEqual(code(`uv run python -c 'x'`), ["x"], "behind a runner");
  assert.deepEqual(code(`python3 <<'EOF'\nx\nEOF`), ["x"]);
  assert.deepEqual(code(`cat <<'EOF' | python3\nx\nEOF`), ["x"], "a here-document piped in");
  assert.deepEqual(code(`echo 'x' | node`), ["x"]);
  assert.deepEqual(
    code(`docker run -e 'A=b' python:3.12 python -c 'x'`),
    ["x"],
    "a flag before the interpreter is the runner's",
  );
  assert.deepEqual(code(`cat <<'EOF'\nx\nEOF`), []);
  assert.deepEqual(code(`grep -e x f`), []);
  assert.deepEqual(code(`echo 'x' | grep x`), []);
});

test("what a line names that could be a path, and the folders it moves to", () => {
  const { parts, dirs } = pathsOf(
    `cd ~/proj && git -C sub show rev:src/z -- {a,b}.txt --out=x/y > log.txt; python3 -c "open('/tmp/q')"`,
  );
  assert.deepEqual(dirs, ["~/proj", "sub"]);
  for (const p of ["a.txt", "b.txt", "x/y", "src/z", "log.txt", "/tmp/q"]) assert.ok(parts.includes(p), p);
  assert.ok(pathsOf("curl https://h/x:8080").parts.includes("https://h/x:8080"), "a URL stays whole");
  assert.deepEqual(pathsOf("cat {a,b}/x a/x").parts, ["cat", "a/x", "b/x"], "each part once");
  assert.deepEqual(pathsOf("cd -").dirs, [], "cd - names no folder");
});

test("a word of many brace groups expands at most 64 of them", () => {
  // First, so a higher limit fails here, before the JSON below costs gigabytes.
  const expanded = pathsOf("cat {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}/x").parts.filter((p) => p !== "cat");
  assert.equal(expanded.length, 64, "the first 64 of 128 expansions");
  // Expanding every group of a JSON body this size would overflow the stack.
  const json = `curl -d '[${Array.from({ length: 10_000 }, (_, i) => `{"a":${i},"b":2}`)}]'`;
  assert.ok(pathsOf(json).parts.length > 0);
});
