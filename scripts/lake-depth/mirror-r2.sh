#!/usr/bin/env bash
#
# Mirror the depth-source archive to a PRIVATE R2 bucket (N6a).
#
#   scripts/lake-depth/mirror-r2.sh push [<key>]
#   scripts/lake-depth/mirror-r2.sh pull [<key>]
#   scripts/lake-depth/mirror-r2.sh status
#
# `.raw/` holds HydroLAKES, GLOBathy and LAGOS-US DEPTH exactly as their publishers served them.
# Two of the three are large (763 MB and 116 MB) and the third cannot be re-downloaded by a script at
# all — it is behind an EDI portal login with a CAPTCHA. So this archive is not a convenience: for
# LAGOS-US it is the only automatable copy that will ever exist, and losing it means a human repeats
# the download by hand.
#
# Config: cp .env.example .env.local and set RAW_BUCKET / RCLONE_REMOTE. Shared body in
# ../lib/mirror-r2.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HERE/.env.local" ] && source "$HERE/.env.local"

ARCHIVE_LABEL="lake-depth-sources"
ARCHIVE_DIR="$HERE/.raw"
DEFAULT_BUCKET="skating-raw-lake-depth"

# shellcheck source=../lib/mirror-r2.sh
source "$HERE/../lib/mirror-r2.sh"

mirror_main "$@"
