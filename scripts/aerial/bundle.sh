#!/usr/bin/env bash
#
# The image's two TypeScript halves, bundled on the laptop before an image build (B05 §2.2, §2.4):
# the worker's packer (`src/tilesPackMain.ts`) and the assembler (`src/cli/assemble.ts`), each one
# self-contained ES module, written to `.scratch/image/` (gitignored), which the Dockerfile copies.
#
#   scripts/aerial/bundle.sh
#
# On the laptop rather than in the image build because `pnpm install` inside the build can't pass
# the workspace's supply-chain check: it fetches metadata for every lockfile entry, one of them from
# a registry that needs a token the build doesn't have (measured 2026-11-25: a 401). The laptop's
# install already passed it. `esbuild` is @skating/aerial's devDependency.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
OUT=".scratch/image"
ESBUILD="${ESBUILD:-pnpm exec esbuild}"
mkdir -p "$OUT"
# A bundled ES module has no `require`; a CommonJS dependency gets one back from this banner.
BANNER="import { createRequire as __aerialRequire } from 'node:module'; const require = __aerialRequire(import.meta.url);"
for entry in src/tilesPackMain.ts:tiles-pack.mjs src/cli/assemble.ts:assemble.mjs; do
  $ESBUILD "${entry%%:*}" --bundle --platform=node --format=esm --target=node26 \
    --banner:js="$BANNER" --outfile="$OUT/${entry##*:}" --log-level=warning
done
ls -l "$OUT"
