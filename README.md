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

**Protected folders** are matched by name, case-insensitively, with symlinks resolved.
- The agent can't use `read`, `ls`, `edit`, `write`, `grep` or `find` on a path inside one.
- A bash command that names such a path is refused.
- So is any other tool argument that is one, such as an MCP tool opening `file:///…/vault/x`.
- Lines that name a protected path are removed from `grep`, `find` and bash output.

**Secret files:** in what `read`, `grep` and bash return, and in the output of `env` and `printenv`, these become `[REDACTED]`:
- the values of secret-looking names;
- passwords inside URLs;
- private-key blocks.

Writing `[REDACTED]` into a secret file is refused, so a redacted copy can't replace the real one.

**Subagents:** if [pi-subagents](https://www.npmjs.com/package/pi-subagents) is installed, its subagents load this guard too.

## command-guard

Settings go under `commandGuard` in `settings.json`:

| Key              | Default                  | Meaning                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builtins`       | `["rm", "sudo", "find"]` | Which built-in checks run: `rm` catches a recursive rm, `sudo` anything run through sudo or doas, and `find` a find with `-delete`, or with `-exec`, `-execdir` or `-ok` running rm                                                                                                                                               |
| `rules`          | `[]`                     | More commands to confirm, such as `{ "command": "git reset", "args": ["--hard"], "reason": "discards uncommitted work" }`. A rule matches a command that starts with those words, in order. If `args` is given, the command must also include one of them. A short flag such as `-f` also matches inside a cluster such as `-fd`. |
| `timeoutSeconds` | `120`                    | How long the question waits. No answer counts as no.                                                                                                                                                                                                                                                                              |
- **Splitting:** commands are split as the shell would split them. That covers pipelines, `&&` chains, `bash -c '…'`, `eval`, `xargs`, `env` and `sudo`. Text inside a quoted argument or a here-document, such as a commit message, isn't mistaken for a command.
- **Temp directories:** a recursive rm or find whose targets all lie inside a temp directory runs without asking.
- **No UI:** where nobody can be asked, such as print mode or background subagents, the command is refused.

## Settings scope

For both guards, the global `~/.pi/agent/settings.json` decides. A project's `.pi/settings.json` can add folders, keys, checks and rules, but can't remove any. Only the global settings set `timeoutSeconds`.

## Limits

The guards catch accidents. They don't sandbox a determined agent: a glob that never names a protected folder can still print the files inside it, and a script can do anything its interpreter allows. For real isolation, run the agent where the secrets aren't.

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
