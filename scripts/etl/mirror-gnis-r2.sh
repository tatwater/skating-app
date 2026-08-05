#!/usr/bin/env bash
#
# Mirror the GNIS Domestic Names archive to a PRIVATE R2 bucket (water ETL, N7 / D105).
#
#   scripts/etl/mirror-gnis-r2.sh push
#   scripts/etl/mirror-gnis-r2.sh pull
#   scripts/etl/mirror-gnis-r2.sh status
#
# **The smallest archive in the repo and one of the two that most needs mirroring.** ~2.8 MB, against
# NHD's 924 MB — but the GNIS staged URL carries no vintage and is overwritten in place, so unlike
# TIGER (whose year is in the path, and whose 2020 files are still served) today's gazetteer is
# unrecoverable tomorrow.
#
# And a GNIS name is not cosmetic here: D96 admits a NAMED wetland at five acres and refuses an
# unnamed one under fifty, so this file decides which bodies exist. An un-pinned gazetteer means the
# corpus changes shape between runs for a reason nothing records.
#
# Config: cp .env.gnis.example to .env.gnis.local. Shared body in ../lib/mirror-r2.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Its OWN config file. The shared body honours an inherited `RAW_BUCKET` over `DEFAULT_BUCKET`, so
# sourcing a sibling's `.env` here would push this archive into that bucket and report success —
# which is exactly the bug a `sed`-generated mirror script produced once already.
# shellcheck disable=SC1091
[ -f "$HERE/.env.gnis.local" ] && source "$HERE/.env.gnis.local"

ARCHIVE_LABEL="gnis-domestic-names"
ARCHIVE_DIR="$HERE/.raw-gnis"
DEFAULT_BUCKET="skating-raw-gnis"

# shellcheck source=../lib/mirror-r2.sh
source "$HERE/../lib/mirror-r2.sh"

mirror_main "$@"
