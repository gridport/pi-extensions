# pi-extensions

One npm package, `@gridport/pi-extensions`, holding three pi extensions in `extensions/`. Code two of them share lives in `src/`. `README.md` says what each does; the `package.json` scripts are the commands.

## Checks

- After any change: `pnpm check`, `pnpm test` and `pnpm test:mutants`, all green.
- When a change touches how an extension talks to pi (events, tools, commands, settings, loading, subagents), and before every release: `pnpm test:live`. It runs locally only, costs a few cents and takes about 10 minutes. CI can't run it.
- New behaviour gets a test and a mutant in `test/mutants.sh` that the test kills. A `BROKEN` mutant means its target text moved: update the entry to the new text.
- The live scripts patch exact lines: `RESTORE` in `test/loop-live-reload.mjs`, and the `joinSubagents` import of `secret-guard.ts` in `test/guards-live.mjs`. They throw if the line is gone; keep them matching the code.

## Traps

- pi maps `@earendil-works/*` and `typebox` to its own copies. They are `"*"` peers, plus pinned dev dependencies for `tsc` and the tests. Keep them out of `dependencies`: pi warns, and a bundled copy can split classes and registries.
- pi loads the `.ts` files directly, and the tests run them through Node's type stripping. So use only erasable syntax (the tsconfig enforces it), and give relative imports their `.ts` extension.
- The guards' settings: the global `settings.json` decides, and a project can only add. Project settings come from whatever repository the agent is working in, so they must never weaken a guard. Keep this when adding settings.
- Pin exact versions. pnpm here refuses versions published less than a day ago (`minimumReleaseAge`), so pick the newest version it accepts.

## Releases

- Bump `version` in `package.json`, and move the `CHANGELOG.md` notes under it. Then publish a GitHub release tagged `v<version>`. `.github/workflows/cd.yml` checks the tag, runs the checks, and publishes through npm trusted publishing.
- Trusted publishing can't create a package, so the first one is a bootstrap:
  1. Publish 0.0.1 by hand from the committed tree (`npm publish`, with 2FA). It has no provenance.
  2. On npmjs.com, add `gridport/pi-extensions` with `cd.yml` as the package's trusted publisher.
  3. Release 0.1.0 through `cd.yml`.
  4. Run `npm deprecate @gridport/pi-extensions@0.0.1 "use 0.1.0 or later"`.

## GitHub

- The repository is `gridport/pi-extensions`. Write to it as `kigawas`. The active `gh` account on this machine is a different one, so prefix commands with `GH_TOKEN=$(gh auth token --user kigawas)` instead of switching accounts.
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `chore:` and so on.
- Don't push or publish unless asked.
