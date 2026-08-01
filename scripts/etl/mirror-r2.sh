#!/usr/bin/env bash
#
# Mirror the OSM extract archive to a PRIVATE R2 bucket (water ETL).
#
#   scripts/etl/mirror-r2.sh push [<state>]
#   scripts/etl/mirror-r2.sh pull [<state>]
#   scripts/etl/mirror-r2.sh status
#
# `.raw/` holds the dated Geofabrik extracts a corpus was built from. Geofabrik keeps a dated build
# for a few months and then drops it — which is exactly the window that expired on the last corpus,
# leaving its provenance unrecoverable. This is what makes the next one durable rather than
# merely recorded.
#
# Config: cp .env.example .env.local and set RAW_BUCKET / RCLONE_REMOTE. Shared body in
# ../lib/mirror-r2.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HERE/.env.local" ] && source "$HERE/.env.local"

ARCHIVE_LABEL="osm-extracts"
ARCHIVE_DIR="$HERE/.raw"
DEFAULT_BUCKET="skating-raw-lake-osm"

# shellcheck source=../lib/mirror-r2.sh
source "$HERE/../lib/mirror-r2.sh"

mirror_main "$@"
