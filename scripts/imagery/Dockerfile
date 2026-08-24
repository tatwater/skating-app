# The granule cutter (N6e PR 2, D148).
#
# One container, one job: read a single Sentinel granule, cut every corpus body out of it, write a
# masked raster PMTiles to R2, exit. It is deliberately a *batch* image with no server in it — see
# `fly.toml` for why the Fly app has no services, and README.md for the run model.
#
# ## Why this base
#
# `ubuntu-small-3.13.2` pins the **same GDAL the repo's other ETLs are developed against** (compare
# `gdalinfo --version` locally — 3.13.2 "Iowa City"). Pinning to `-latest` would mean the box quietly
# drifts away from the machine a person debugs on, and a masking bug that only reproduces in the cloud
# is the worst kind this pipeline could have. The `small` variant is the right one: it carries the
# drivers we need (GTiff, COG, MBTiles, and critically the `/vsis3/` + `/vsicurl/` virtual filesystems
# that let GDAL read a remote COG's windows without downloading the whole granule) and omits the ~2 GB
# of Oracle/HDF/FileGDB drivers we do not.
#
# ## Python: not added, but used where it is the right tool
#
# The transform itself is GDAL CLI, matching this repo's stack — every ETL under `scripts/` is
# TypeScript orchestration shelling out to GDAL/tippecanoe/pmtiles (see `scripts/bathymetry/tile.sh`),
# and rasterio/rio-tiler would be a second dependency tree for capability already on the PATH.
#
# **But the base image already ships Python 3, the GDAL bindings and numpy** — probed on a real
# Machine, 2026-08-24: `PYTHON+GDAL OK 3.13.2 2.3.5`. So the per-body zonal statistic (§3) costs no new
# dependency, and doing it in numpy is one sweep over two arrays where the pure-CLI equivalent is a
# cross-tabulation GDAL has no command for. Using what is already installed is not the same as adding
# a stack.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.2

# rclone is how every other artifact in this repo reaches R2 (`scripts/basemap/upload-r2.sh`,
# `scripts/*/mirror-r2.sh`), and reusing it means the bucket-scoped-token quirks are already solved
# --- notably `--s3-no-check-bucket`, because our R2 tokens 403 on the account-level HeadBucket probe.
# jq parses the STAC responses. curl + ca-certificates are what `/vsicurl/` leans on.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      jq \
      rclone \
 && rm -rf /var/lib/apt/lists/*

# pmtiles converts the MBTiles GDAL writes into the single-file archive both clients already read
# natively (the bathymetry overlay and the basemap take the identical last step).
ARG PMTILES_VERSION=1.31.2
ARG TARGETARCH=amd64
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) PM_ARCH=x86_64 ;; \
      arm64) PM_ARCH=arm64  ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${PM_ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin pmtiles; \
    chmod +x /usr/local/bin/pmtiles; \
    pmtiles version

# GDAL tuning for reading remote COGs. These matter more than they look: the whole cost argument in
# D148 rests on reading *windows* of a granule over HTTP rather than pulling the file down.
#
# ## ⚠ `GDAL_CACHEMAX` is set in absolute megabytes, and that is deliberate
#
# GDAL defaults its block cache to **5% of available RAM**, which quietly couples cache size to the
# single most expensive dial on the Machine. Fly bills RAM at roughly 5.6x the CPU for this shape of
# job — of $6.36 spent through 2026-08-24, **$5.19 was "Additional RAM"** — so the backfill wants
# 2048 MB rather than the 8192 MB it had been running at. Left on the default, that drop would have
# taken the block cache from ~410 MB to ~102 MB along with it, slowing exactly the tiling stages that
# dominate a job and clawing back part of the saving in machine-seconds.
#
# 410 MB restores the cache the 8 GB Machine had (8192 x 5%) inside a 2 GB one, and states it as a
# number so that changing `FLY_VM_MEMORY` never silently moves it again. Headroom checks out: the
# largest granule completed in 1024 MB with a ~51 MB cache, so its non-cache working set is ~970 MB,
# and 970 + 410 leaves ~660 MB spare at 2048.
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MULTIPLEX=YES \
    GDAL_HTTP_VERSION=2 \
    GDAL_NUM_THREADS=ALL_CPUS \
    GDAL_CACHEMAX=410 \
    VSI_CACHE=TRUE \
    VSI_CACHE_SIZE=536870912 \
    CPL_TMPDIR=/data

# Scratch lives on the Machine's ephemeral root disk, never a Fly volume. Volumes are host-pinned
# with no multi-attach, which is exactly wrong for a job that wants 25 copies of itself running on
# whatever hosts are free. Nothing here needs to survive the process.
WORKDIR /data

COPY cut-granule.sh /usr/local/bin/cut-granule
COPY zonal-clear.py /usr/local/bin/zonal-clear.py
COPY tiles-to-mbtiles.py /usr/local/bin/tiles-to-mbtiles.py
RUN chmod +x /usr/local/bin/cut-granule /usr/local/bin/zonal-clear.py \
      /usr/local/bin/tiles-to-mbtiles.py

# The contract, and the reason it is this narrow: `docker run <image> <granule-id>`. One granule id in,
# one artifact in R2 out, a nonzero exit if that did not happen. Nothing about Fly appears below this
# line, which is what keeps D148's "lock-in is low if orchestration stays host-neutral" true rather
# than aspirational. Moving to Railway, Batch, or a laptop is then a change of caller, not of code.
ENTRYPOINT ["/usr/local/bin/cut-granule"]
