# Review notes

What an adversarial review of this repository needs beyond [AGENTS.md](../AGENTS.md): what a defect costs here, how to run things, and the traps earlier reviews found. The reviewer reads this file before the diff, so a brief adds to it rather than repeating it.

## Stakes

The guards run on every `tool_call` and `tool_result` in every pi session that installs them, and in pi-subagents' children. Rank findings by what they cost, most first:
1. **A leak:** secret-guard shows the model a secret value, a key line, or a line that names or comes from a protected folder. pi passes the original output on when a `tool_result` handler throws, so secret-guard's handler catches every throw and withholds the output: code outside that catch is a leak, and so is an error a filter catches and reads as no file.
2. **A destructive command run unasked:** one command-guard should have asked about, such as a recursive delete, a command run through sudo, or one a rule names.
3. **A project setting that weakens a guard**, ranked at least as high as what it lets through, since project settings come from whatever repository the agent works in (AGENTS.md, Traps).
4. **A stall, a false stop, or hidden output.** A slow path blocks pi's event loop on every call. A false refusal or a needless ask stops ordinary work, and in a subagent, which has no UI, command-guard refuses rather than asks. Over-redaction, such as `[REDACTED]` in the agent's own code diffs, and a dropped pi notice, which passes a cut output off as whole, hide what the agent needs.
5. Then loop's schedule, other correctness, the README, cost and style.

The guards catch accidents, not a determined agent. Judge a gap by whether a coding agent would plausibly write that command or make that call in ordinary work. Content from a hostile repository or a fetched page, such as output that imitates pi, counts only as far as it causes harm without the agent trying. A gap the README's Limits already names isn't a finding, unless the Limits text is wrong or misleading about it.

## Gates

CI (`.github/workflows/ci.yml`) runs `pnpm check`, `pnpm test`, `pnpm test:mutants` and `pnpm test:pack`, on Node 22 and 24. Run all four; the mutants and the pack test work in temp directories, so they leave the tree alone.

## Running rules

- **Never run `pnpm test:live` or `test/live.sh`.** It costs money, needs a model and takes about 10 minutes. The author runs it and gives its result in the brief.
- **Reproduce through the harness.** `test/guard-harness.ts` loads a guard against a fake pi and calls its real `tool_call` and `tool_result` handlers; the tests show how. Feed it what pi really produces: `test/pi-output.test.ts` runs pi's own bash and read tools in-process. A finding with a harness call and its output is ran, not reasoned.
- **pi's own source** is under `node_modules/.pnpm/@earendil-works+pi-coding-agent@<version>*/node_modules/@earendil-works/pi-coding-agent/dist`, with `pi-agent-core` beside it. Settle how pi calls a hook, shapes a tool's output or treats a throw by reading it there: `core/extensions/runner.js`, `core/tools/bash.js`, `core/tools/output-accumulator.js`.
- **Mutate a copy, not the tree.** `test/mutants.sh` copies the tree for every mutant, so an edit there during a run changes every mutant after it. Build a probe mutant as it does: copy `extensions`, `src`, `test` and `package.json` into your scratch directory and link `node_modules`.
- **A baseline worktree** needs `pnpm install --offline` before its tests run.
- **Delete every `pi-bash-*.log` your probes create**, by its literal path.

## Traps

Each of these was found by an earlier review, most more than once:
- **A fix that regresses.** More than one round's worst finding was brought in by the last round's fix. Run a fix and the commits before it on the same inputs, such as a differential fuzz over whole outputs, rather than trusting the fix's own tests.
- **pi shows only part of an output.** A bash tail, with the whole in a `pi-bash-*.log`; a read from an offset, which may be fractional; and codemode's structured copy of an output over 1 MiB, its head and tail around a `[... N bytes omitted ...]` line. Check each copy on its own: a section that opens in the part pi leaves out still governs the lines shown after it. Content replaced without `structuredContent` makes pi drop codemode's copy.
- **Output that imitates pi.** A command's own output, or a file's content, can print lines shaped like pi's trailing notice or its omission marker. Code that trusts such a line must take pi's real one: the last notice, at the place pi puts it.
- **Real tools' output formats.** Redaction tested on bare `KEY=value` lines misses the shapes real tools print: grep's and rg's `path:N:` and `path-N-` prefixes, nested inside a log's own; `cat -n`; `git blame` lines that start with a hash; a hunk header's `@@ … @@ KEY=value`; `diff -c`'s `! `; git's quoted non-ASCII paths in a header; CRLF line ends. Run real git and grep on a fixture `.env` holding a private key, through each tool and redaction mode.
- **Paths in every form an agent writes them:** a glob, including a partial last segment and one that can match `..`; `..` after a symlink, which resolves where the link leads, not by text; a quoted path; a relative path after `cd`; `$TMPDIR`, which ends in `/` on macOS; `--flag=path` and `key:path`; a `file://` URL; and a path inside interpreter code (`python3 -c`, `node -e`, `perl -e`).
- **Cost on large input.** A regex that backtracks more than linearly, or work repeated per line, stalls pi on a log of hundreds of megabytes, and so does parsing a long command in `tool_call`, such as a `curl -d` JSON body full of braces. Time a probe at that size, and watch its memory: one line of hundreds of megabytes has run node out of heap. A log too big to read whole (`ERR_STRING_TOO_LONG` past V8's longest string, `ERR_FS_FILE_TOO_LARGE` past 2 GiB) must fail closed: withheld in `tool_result`, refused in `tool_call`. A catch that treats it as no file filters from a clean start and leaks.
- **The README's claims.** Check each form the README says a guard covers, and each gap Limits names, against the code: reviews found covered forms that passed and Limits lines that understated a gap.
