# pi-extensions

Three extensions for the [pi coding agent](https://pi.dev):
- **loop** fires a saved prompt into the session on a cron schedule.
- **secret-guard** keeps the agent out of protected folders and redacts secrets from `.env` files.
- **command-guard** asks before the agent runs a destructive shell command.

## Install

```bash
pi install npm:@gridport/pi-extensions
```

Add `@<version>` to pin a version; without one, `pi update` moves to the latest. That loads all three. To load only some, list them in the package entry in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "npm:@gridport/pi-extensions",
      "extensions": ["extensions/secret-guard.ts", "extensions/command-guard.ts"]
    }
  ]
}
```

They need pi 1.4.0 or later.

## loop

The agent arms jobs with the `loop` tool, like Claude Code's `CronCreate`. You can manage them by hand with `/loop`:

```text
/loop                              list jobs
/loop */30 * * * * check the CI    add a recurring job: 5 cron fields, then the prompt
/loop delete <id|all>              delete jobs
```

- A job fires only while the session is idle. A firing that comes due while the agent is busy or compacting is sent once it settles. Firings missed while busy or asleep collapse into one.
- After you press Esc, pending firings wait 5 minutes, so the session stays yours to type into.
- Times are local. Unlike cron, a job in the hour repeated by a daylight-saving change fires twice, and one in the skipped hour doesn't fire.
- Jobs belong to the session. They survive `/reload`, but not a restart, `/new`, `/resume` or `/fork`. A restarted or forked session tells you which jobs lapsed.
- A job expires 7 days after it was created.
- The same prompt can't be armed twice, so renewing a loop can't double it.

A firing sends its prompt as a plain message, without expanding prompt templates. So a prompt that should run a skill names the skill in words, rather than as `/skill:name`.

## secret-guard

Settings go under `secretGuard` in `settings.json`:

| Key           | Default                                                                                                        | Meaning                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `folders`     | `["vault"]`                                                                                                    | Folder names whose contents are off limits                                                                                   |
| `redactFiles` | `[".env", ".env.*", "*.env", ".envrc"]`                                                                        | File-name globs whose secret values are redacted                                                                             |
| `redactKeys`  | `PASSWORD`, `PASSWD`, `PASSPHRASE`, `SECRET`, `TOKEN`, `KEY`, `APIKEY`, `CREDENTIAL`, `CREDENTIALS`, `PRIVATE` | Name parts that mark a value as secret. A part of 5 or more letters also matches inside a longer name, such as `DBPASSWORD`. |

**Protected folders** are matched by name, in any case, with symlinks resolved. A path into one, such as `vault/x`, counts wherever it appears, since it may be relative to a repository's root or another folder. The folder itself, such as `vault` or `x/vault`, counts only where a folder by that name exists, so a command such as `vault status` is fine in a project with no `vault` folder.
- The agent can't use `read`, `ls`, `edit`, `write`, `grep` or `find` on a path inside one.
- A bash command that names such a path is refused. That includes `git show HEAD:vault/x` and the code an interpreter runs, whether given to `python -c`, `node -e` or `deno eval`, or piped in from `echo` or a here-document.
- So is any other tool argument that is one, such as an MCP tool opening `file:///…/vault/x`.
- Lines that name a protected path are removed from `grep`, `find` and bash output. So are the whole `git diff` and `git log -p` sections of files inside one.
- pi saves a long bash output to a file and shows only its tail. When that file holds such a section, a bash command or `grep` that names it is refused, even in an interpreter's code, so the agent reads it with `read`, which leaves the section out wherever the read starts. pi's own lines after an output, such as where to find the rest, are always kept.

**Secret files:** these become `[REDACTED]` in what `read`, `grep` and bash return, `grep`, `rg`, `cat -n` and `diff` lines included, in a secret file's `git diff` and `git log -p` sections in bash output and pi's file of it, even when the command doesn't name the file, and in the output of `env`, `printenv`, `export` and `declare`:
- the values of secret-looking names;
- passwords inside URLs;
- private-key blocks, PGP ones included, even when only part of one shows, such as a `read` from inside it or a `tail` of it.

In a secret file's diff section, a hunk header loses the text git adds after it, which comes from a line before the hunk and may be one inside a key.

`printenv NAME` prints a bare value, so when the name looks secret, its whole output is redacted. pi saves a long bash output to a file and tells the agent to read it. Whatever the command, what `read`, `grep` or a bash command that names that file returns is redacted the same way. Writing `[REDACTED]` into a secret file is refused, so a redacted copy can't replace the real one.

## command-guard

Settings go under `commandGuard` in `settings.json`:

| Key              | Default                  | Meaning                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builtins`       | `["rm", "sudo", "find"]` | Which built-in checks run: `rm` catches a recursive rm, `sudo` anything run through sudo or doas, and `find` a find with `-delete`, or with `-exec`, `-execdir` or `-ok` running rm                                                                                                                                               |
| `rules`          | `[]`                     | More commands to confirm, such as `{ "command": "git reset", "args": ["--hard"], "reason": "discards uncommitted work" }`. A rule matches a command that starts with those words, in order. If `args` is given, the command must also include one of them. A short flag such as `-f` also matches inside a cluster such as `-fd`. |
| `timeoutSeconds` | `120`                    | How long the question waits. No answer counts as no.                                                                                                                                                                                                                                                                              |
- **Splitting:** commands are split as the shell would split them. That covers pipelines, `&&` chains, `bash -c '…'`, `eval`, `xargs`, `env` and `sudo`, and what `echo` or a here-document pipes into a shell. Text inside a quoted argument or a here-document, such as a commit message, isn't mistaken for a command.
- **Temp directories:** a recursive rm or find whose targets all lie inside a temp directory runs without asking.
- **No UI:** where nobody can be asked, such as print mode or a subagent, the command is refused.

## Subagents

With [pi-subagents](https://www.npmjs.com/package/pi-subagents) installed in pi's own npm directory (`pi install npm:pi-subagents`), its subagents load both guards. A subagent can't ask you, so command-guard refuses there whatever it would ask about. A project-local or git install of pi-subagents isn't found, and its subagents run without the guards.

## Settings scope

For both guards, the global `~/.pi/agent/settings.json` decides. A project's `.pi/settings.json` can add folders, keys, checks and rules, but can't remove any. Only the global settings set `timeoutSeconds`.

## Limits

The guards catch accidents. They don't sandbox a determined agent. Some things they let through:
- a glob that never names a protected folder, such as `cat */secret.txt`;
- a script that opens a protected file by a path it builds itself;
- a word whose brace expansion yields more than 64 paths: only the first 64 are checked;
- the folder itself named in a way they don't follow, such as after `cd -` or a second `cd`, or through a variable such as `$HOME/vault`. Paths into it are still removed from output, but output that prints none, such as `grep -rh`, gets through;
- a protected or secret file's `git diff` section whose header never reaches them: output piped through `grep` or `tail`, `git log --graph`, `--color=always` or `--word-diff`, `diff -r` of two folders, or pi's file of a long output named through a glob or a variable;
- code an interpreter reads from a file, or that something other than `echo`, `printf` or a here-document pipes in;
- a bare value, as `printenv NAME` prints it, in pi's file of a long output, and any value in that file when a command names it through a glob;
- a secret file's diff saved to a file, such as `git diff > changes.diff`, then opened with `read` or `grep`;
- a secret printed some other way, such as `echo $API_KEY`, or in a format they don't parse, such as `rg --json` or `rg --heading`;
- the lines after the first of a multi-line quoted value, and the middle of a private-key block shown without its BEGIN or END line, as `sed -n 5,10p` of a key file or a diff hunk inside one shows it;
- pi's optional `powershell` tool, which neither guard checks;
- for command-guard, deletions it doesn't model, such as `find -exec sh -c 'rm -rf …'` or `fd -X rm -rf`.

For real isolation, run the agent where the secrets aren't.

## Development

```bash
pnpm install
pnpm check          # Biome and tsc
pnpm test           # the fast tests
pnpm test:mutants   # breaks the code on purpose; a test must catch each break
pnpm test:pack      # the packed tarball loads
pnpm test:live      # real pi over RPC with a model; local only, see test/live.sh
```

## License

MIT
