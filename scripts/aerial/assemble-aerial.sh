#!/usr/bin/env bash
#
# The assembler's entrypoint on its Machine (B05 §2.4): `assemble-aerial <campaign> [--pilot <name>]`.
#
# Writes the `[r2]` rclone remote from the Fly app's staged secrets — at run time, never baked into
# the image, as `cut-granule.sh` and `cut-aerial.sh` do — exports `RCLONE_CONFIG`, checks the tools
# the assembler shells out to (`rclone` for every byte to and from R2, `gdal_translate` for the
# overview zooms), and hands over to the bundled assembler (`src/cli/assemble.ts`, which reads
# `R2_BUCKET` and, on a Machine, `FLY_MACHINE_ID`). Nothing here prints a value.
set -euo pipefail

die() { echo "[assemble-aerial] FATAL: $*" >&2; exit 1; }

for var in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT R2_BUCKET; do
  [[ -n "${!var:-}" ]] || die "missing required secret: $var"
done
for tool in rclone gdal_translate node; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH"
done

WORKDIR="${AERIAL_WORKDIR:-/data}"
mkdir -p "$WORKDIR"
export RCLONE_CONFIG="$WORKDIR/rclone.conf"
(
  umask 077
  cat > "$RCLONE_CONFIG" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = ${R2_ENDPOINT}
region = auto
acl = private
EOF
)

exec node "${AERIAL_ASSEMBLE:-/app/dist/assemble.mjs}" "$@"
