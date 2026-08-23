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
# ## Why no Python
#
# The tempting stack here is rasterio/rio-tiler, and it is a fine stack. It is not *this repo's* stack:
# every ETL under `scripts/` is TypeScript orchestration shelling out to GDAL/tippecanoe/pmtiles CLIs
# (see `scripts/bathymetry/tile.sh`). GDAL 3.13's unified `gdal raster` CLI covers the whole transform
# — clip, warp, tile — so adding a Python runtime would buy a second dependency tree and a second set
# of version pins for capability we already have on the PATH.
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
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MULTIPLEX=YES \
    GDAL_HTTP_VERSION=2 \
    GDAL_NUM_THREADS=ALL_CPUS \
    VSI_CACHE=TRUE \
    VSI_CACHE_SIZE=536870912 \
    CPL_TMPDIR=/data

# Scratch lives on the Machine's ephemeral root disk, never a Fly volume. Volumes are host-pinned
# with no multi-attach, which is exactly wrong for a job that wants 25 copies of itself running on
# whatever hosts are free. Nothing here needs to survive the process.
WORKDIR /data

COPY cut-granule.sh /usr/local/bin/cut-granule
RUN chmod +x /usr/local/bin/cut-granule

# The contract, and the reason it is this narrow: `docker run <image> <granule-id>`. One granule id in,
# one artifact in R2 out, a nonzero exit if that did not happen. Nothing about Fly appears below this
# line, which is what keeps D148's "lock-in is low if orchestration stays host-neutral" true rather
# than aspirational. Moving to Railway, Batch, or a laptop is then a change of caller, not of code.
ENTRYPOINT ["/usr/local/bin/cut-granule"]
