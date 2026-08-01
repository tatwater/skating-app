#!/usr/bin/env bash
#
# Mirror the state-agency bathymetry archive to a PRIVATE R2 bucket (N6b).
#
#   scripts/bathymetry/mirror-r2.sh push [<source-key>]
#   scripts/bathymetry/mirror-r2.sh pull [<source-key>]
#   scripts/bathymetry/mirror-r2.sh status
#
# `.raw/` is the archive that makes reprocessing free — the transform is the part we iterate on, and
# an archive living on exactly one laptop is not an archive. This is the second copy.
#
# Config: cp .env.example .env.local and set RAW_BUCKET / RCLONE_REMOTE. The shared body, including
# the copy-never-sync rule and the setup instructions on a 403, is in ../lib/mirror-r2.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HERE/.env.local" ] && source "$HERE/.env.local"

ARCHIVE_LABEL="bathymetry"
ARCHIVE_DIR="$HERE/.raw"
DEFAULT_BUCKET="skating-raw-lake-bathymetry"

# shellcheck source=../lib/mirror-r2.sh
source "$HERE/../lib/mirror-r2.sh"

mirror_main "$@"
