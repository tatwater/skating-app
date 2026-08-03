#!/usr/bin/env bash
#
# Mirror the WIND Toolkit response archive to a PRIVATE R2 bucket (N7 prep).
#
#   scripts/wind-climate/mirror-r2.sh push|pull|status
#
# **This exists before the archive it mirrors, on purpose.** The wind fetch is 5,225 requests and
# ~7.7 hours against a shared daily quota, and the reason it has to be archived at all is that the
# last run fetched wind SPEED and threw it away — turning a two-minute local recompute into a
# 7.7-hour re-fetch. See plans/HANDOFF-wind-climate-archive.md.
#
# Standing this up now means the durable copy is one command away the moment `.raw/` has anything in
# it, rather than a step somebody remembers after the expensive part is already done.
#
# Config: cp .env.example .env.local. Shared body in ../lib/mirror-r2.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
[ -f "$HERE/.env.local" ] && source "$HERE/.env.local"

ARCHIVE_LABEL="wind-climate-wtk"
ARCHIVE_DIR="$HERE/.raw"
DEFAULT_BUCKET="skating-raw-wind-climate"

# shellcheck source=../lib/mirror-r2.sh
source "$HERE/../lib/mirror-r2.sh"

mirror_main "$@"
