#!/bin/bash
# The live tests: real pi over RPC with a cheap model, about 10 minutes and a
# few cents. They run on the package as npm would ship it, unpacked in a temp
# directory with no node_modules, so a file missing from the tarball fails here.
# Needs pi on PATH, pi-subagents installed in pi, and a model: PI_TEST_MODEL,
# by default the maintainer's magpie route. Local only; CI has none of these.
#
#   test/live.sh                    all three
#   test/live.sh guards-live.mjs    just the named ones
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
command -v pi >/dev/null || { echo "live tests need pi on PATH" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/pi-extensions-live.XXXXXX")
trap 'rm -rf "$work"' EXIT
(cd "$repo" && pnpm pack --pack-destination "$work" >/dev/null)
tar -xzf "$work"/*.tgz -C "$work"
cp -R "$repo/test" "$work/package/"
cd "$work/package"
echo "pi $(pi --version), node $(node --version), model ${PI_TEST_MODEL:-magpie/anthropic/claude-haiku-5-5}"

tests=("$@")
[ ${#tests[@]} -gt 0 ] || tests=(loop-live.mjs loop-live-reload.mjs guards-live.mjs)
for t in "${tests[@]}"; do node "test/$t"; done
