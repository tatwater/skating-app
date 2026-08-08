#!/usr/bin/env bash
#
# Mirror the 3DHP waterbody clip to a PRIVATE R2 bucket (water ETL, N7).
#
#   scripts/etl/mirror-3dhp-r2.sh push
#   scripts/etl/mirror-3dhp-r2.sh pull
#   scripts/etl/mirror-3dhp-r2.sh status
#
# **Only `.raw-3dhp/waterbody/` is mirrored, never `.raw-3dhp/source/`.** 3DHP has no per-state
# staging: it ships CONUS-wide as an 11.9 GB geodatabase of national flowlines and catchments, of
# which we want a ~300 MB waterbody clip. Mirroring the whole thing would grow the bucket by ~12 GB
# per ANNUAL release, in data nothing reads. What preserves reproducibility instead is the source
# manifest — URL, byte count, sha256 — plus the exact `ogr2ogr` command, both recorded by
# `archive-3dhp`. See `src/threeDhpArchive.ts` for the full argument.
#
# This is a bucket that grows once a year, on purpose (see the README's refresh runbook).
#
# Config: cp .env.3dhp.example to .env.3dhp.local. Shared body in ../lib/mirror-r2.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Its OWN config file, like the NHD mirror's. The shared body honours an inherited `RAW_BUCKET` over
# `DEFAULT_BUCKET`, so sourcing a sibling's `.env` here would push this archive into that bucket and
# report success. Three archives in one package, three config files — and generating this file by
# `sed`ing the NHD one produced exactly that bug before it was written out by hand.
# shellcheck disable=SC1091
[ -f "$HERE/.env.3dhp.local" ] && source "$HERE/.env.3dhp.local"

ARCHIVE_LABEL="3dhp-waterbody-clip"
ARCHIVE_DIR="$HERE/.raw-3dhp/waterbody"
DEFAULT_BUCKET="skating-raw-3dhp"

# shellcheck source=../lib/mirror-r2.sh
source "$HERE/../lib/mirror-r2.sh"

mirror_main "$@"
