#!/usr/bin/env bash
#
# Mirror the NHD geodatabase archive to a PRIVATE R2 bucket (water ETL, N7).
#
#   scripts/etl/mirror-nhd-r2.sh push [<state>]
#   scripts/etl/mirror-nhd-r2.sh pull [<state>]
#   scripts/etl/mirror-nhd-r2.sh status
#
# `.raw-nhd/` holds the five NHD High Resolution state geodatabases the unified corpus is built from.
# The mirror matters more here than it does for OSM: **USGS retired NHD on 2023-10-01**, so these are
# a final snapshot on a staged-products bucket with no successor and no guarantee of a takedown
# notice. Geofabrik at least rebuilds; this is the only copy anyone will ever publish.
#
# Config: cp .env.nhd.example to .env.nhd.local. Shared body in ../lib/mirror-r2.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# **Deliberately NOT `.env.local`.** That file belongs to the OSM mirror and sets
# `RAW_BUCKET=skating-raw-lake-osm`; the shared body honours an inherited `RAW_BUCKET` over
# `DEFAULT_BUCKET`, so sourcing it here would push a geodatabase archive into the OSM bucket and
# report success. Two archives in one package need two config files, not one shared one.
# shellcheck disable=SC1091
[ -f "$HERE/.env.nhd.local" ] && source "$HERE/.env.nhd.local"

ARCHIVE_LABEL="nhd-hr-geodatabases"
ARCHIVE_DIR="$HERE/.raw-nhd"
DEFAULT_BUCKET="skating-raw-nhd"

# shellcheck source=../lib/mirror-r2.sh
source "$HERE/../lib/mirror-r2.sh"

mirror_main "$@"
