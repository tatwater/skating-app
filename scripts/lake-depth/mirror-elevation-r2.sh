#!/usr/bin/env bash
#
# Mirror the 3DEP elevation archive to a PRIVATE R2 bucket (N7-2).
#
#   scripts/lake-depth/mirror-elevation-r2.sh push
#   scripts/lake-depth/mirror-elevation-r2.sh pull
#   scripts/lake-depth/mirror-elevation-r2.sh status
#
# `.raw-elevation/` holds one line per coordinate: a 3DEP reading, its source raster id, that
# raster's ground sample distance and the date it was flown. It is small — ~25,000 lines, a few MB —
# and that is exactly why it is worth mirroring rather than re-fetching: the bytes are nothing and
# the *time* is four hours against a public service that publishes no rate limit and owes us
# nothing.
#
# The archive is keyed on the COORDINATE rather than on a body id, so it survives a corpus rebuild:
# a lake whose polygon did not change has the same interior point next campaign and costs no
# request at all. Losing this file means paying the four hours again to learn numbers that have not
# moved since the LiDAR was flown.
#
# Separate from `mirror-r2.sh` (and from its bucket) because that one mirrors third-party *source
# data* under licences of varying clarity, where this is a public-domain USGS product we derived
# ourselves. Different provenance, different retention argument, different bucket.
#
# Config: cp .env.example .env.local and set ELEVATION_BUCKET / RCLONE_REMOTE. Shared body in
# ../lib/mirror-r2.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HERE/.env.local" ] && source "$HERE/.env.local"

ARCHIVE_LABEL="usgs-3dep-elevation"
ARCHIVE_DIR="$HERE/.raw-elevation"
DEFAULT_BUCKET="${ELEVATION_BUCKET:-skating-raw-elevation}"

# shellcheck source=../lib/mirror-r2.sh
source "$HERE/../lib/mirror-r2.sh"

mirror_main "$@"
