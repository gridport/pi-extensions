#!/bin/bash
# Checks the package as npm would ship it: packs it, unpacks it in a temp
# directory, and imports every extension its manifest lists, so a file the
# tarball leaves out fails here. Offline, so CI runs it.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/pi-extensions-pack.XXXXXX")
trap 'rm -rf "$work"' EXIT
(cd "$repo" && pnpm pack --pack-destination "$work" >/dev/null)
tar -xzf "$work"/*.tgz -C "$work"
# Stands in for the packages pi supplies to its extensions.
ln -s "$repo/node_modules" "$work/package/node_modules"
cd "$work/package"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const { pi } = JSON.parse(readFileSync("package.json", "utf8"));
for (const file of pi.extensions) {
	const mod = await import(file);
	if (typeof mod.default !== "function") throw new Error(`${file} has no default export`);
	console.log(`loads: ${file}`);
}'
