# Changelog

## 0.1.0 (2026-10-26)

The first release from CI, through npm's trusted publishing, with provenance. It supersedes 0.0.1.

secret-guard:
- Output that pi cuts off is filtered from where pi cut it, using pi's file of the whole output: the tail of a long bash output, a `read` from an offset, and codemode's copy of an output over 1 MiB, around the middle it leaves out. A part of a line is judged by its whole line. A part of a line over 1 MiB, too long to judge, becomes `[REDACTED]`.
- A private key's lines are dropped wherever its END line shows, even without its BEGIN, and even when the END line names a protected path.
- If filtering an output fails, the guard withholds it, since pi would otherwise pass it on unfiltered. A bash command or `grep` that names pi's file of an output too big to read, over 2 GiB, is refused.
- pi's file of an output that holds a protected file's diff is refused to bash by its bare name too, after a `cd` to its folder, as it already was by its path.
- README's limits now list `git blame` among the formats the guards don't parse.

## 0.0.1 (2026-10-25)

The first release: loop, secret-guard and command-guard, ready to use. It's published by hand, since npm's trusted publishing can't create a package, so it has no provenance. 0.1.0, the first release from CI, will supersede it, and 0.0.1 will then be deprecated.
