# The summer aerial's image (B05 §2.2, §2.4): the work tile worker and the assembler.
#
# **Its own image, never the winter cutter's.** The winter season is live and Convex dev's pump
# spawns the pinned cutter image (`FLY_IMAGE`), so this one is built from its own Dockerfile and
# pushed to the same Fly app under its own label; nothing here touches `scripts/imagery/`.
#
# Two entrypoints, no ENTRYPOINT: a Machine is started with its command (`spawn.sh`):
#
#   cut-aerial /data/unit.json                     one work tile, its unit handed in as a file
#   assemble-aerial <campaign> [--pilot <name>]    the archive, its date index, the manifest
#
# **Built from the repo root**: `scripts/aerial/bundle.sh`, then `docker build -f
# scripts/aerial/Dockerfile .` or the README's `fly deploy --build-only`. `Dockerfile.dockerignore`
# beside this file narrows the context to the five files the build copies.

# **Bundle first** (`scripts/aerial/bundle.sh`): the worker's packer and the assembler, two
# self-contained ES modules in `scripts/aerial/.scratch/image/`. The image then needs Node alone —
# no node_modules, no tsx, and no `pnpm install` inside the build, which can't pass the workspace's
# supply-chain check without a registry token the build doesn't have.

# ── The runtime ──────────────────────────────────────────────────────────────────────────────
# The same pinned GDAL as the winter cutter and the laptop the warp proof ran on (3.13.2): a warp
# that only misbehaves in the cloud is the worst kind. The base ships Python 3 with GDAL's bindings
# and numpy, which `aerial-counts.py` uses (the winter cutter probed them on a Machine, 2026-08-24).
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.2

# jq reads the unit and the STAC answers; curl fetches the STAC items and the SAS token; libatomic1
# is the one library Node's binary needs that this base lacks (measured: `node: error while loading
# shared libraries: libatomic.so.1`).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      jq \
      libatomic1 \
 && rm -rf /var/lib/apt/lists/*

# rclone moves every byte to and from R2 — rclone's own release, pinned and checksummed, **not
# Ubuntu's**. The base's apt rclone is 1.60.1, and against R2 every upload's first attempt answers
# `501 NotImplemented` (the pilot, 2026-11-26: every `copyto` of every work tile, then "Attempt 2/3
# succeeded"); `rcat` reads stdin once and can't retry, so the assembler's first write — and with it
# the archive's streamed upload — failed outright. 1.74.4 is the laptop's, which P's stream proof and
# the pilot's probe of `rcat` into the bucket both passed with. The hashes are rclone's SHA256SUMS.
# ⚠ No build argument may start with `RCLONE_`: a RUN sees it as an environment variable, and rclone
# reads every `RCLONE_<FLAG>` as a flag (`RCLONE_VERSION=1.74.4` is `--version=1.74.4`, refused).
ARG TARGETARCH=amd64
ARG DEB_RCLONE_RELEASE=1.74.4
ARG DEB_RCLONE_SHA256_AMD64=a9da2eaa70428c6dcc5acbb0b7eac0faec4c61643e0b468d9fe09ddf79b7e929
ARG DEB_RCLONE_SHA256_ARM64=db39280cd0b680ef2ab2e9800882936358c33b959622512e6898ebbeaf0b7aea
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) RC_SHA="${DEB_RCLONE_SHA256_AMD64}" ;; \
      arm64) RC_SHA="${DEB_RCLONE_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    deb="rclone-v${DEB_RCLONE_RELEASE}-linux-${TARGETARCH}.deb"; \
    curl -fsSL -o "/tmp/${deb}" "https://downloads.rclone.org/v${DEB_RCLONE_RELEASE}/${deb}"; \
    echo "${RC_SHA}  /tmp/${deb}" | sha256sum -c -; \
    dpkg -i "/tmp/${deb}"; \
    rm "/tmp/${deb}"; \
    rclone version

# pmtiles, for reading an archive back on a Machine (the winter cutter's pinned version).
ARG PMTILES_VERSION=1.31.2
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

# Node for the two bundles, the same version as the repo's `.node-version`.
COPY --from=node:26.13.1-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY scripts/aerial/.scratch/image/tiles-pack.mjs scripts/aerial/.scratch/image/assemble.mjs /app/dist/

# Remote-COG tuning: the winter cutter's, block cache in absolute megabytes so the Machine's RAM
# doesn't silently move it (see scripts/imagery/Dockerfile for the measurement).
ENV GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MULTIPLEX=YES \
    GDAL_HTTP_VERSION=2 \
    GDAL_NUM_THREADS=ALL_CPUS \
    GDAL_CACHEMAX=410 \
    VSI_CACHE=TRUE \
    VSI_CACHE_SIZE=268435456 \
    CPL_TMPDIR=/data \
    AERIAL_WORKDIR=/data \
    AERIAL_PACK="node /app/dist/tiles-pack.mjs"

# Scratch on the Machine's ephemeral root disk, never a volume (host-pinned, no multi-attach).
WORKDIR /data

COPY scripts/aerial/cut-aerial.sh /usr/local/bin/cut-aerial
COPY scripts/aerial/aerial-counts.py /usr/local/bin/aerial-counts.py
COPY scripts/aerial/assemble-aerial.sh /usr/local/bin/assemble-aerial
RUN chmod +x /usr/local/bin/cut-aerial /usr/local/bin/aerial-counts.py /usr/local/bin/assemble-aerial \
 && python3 -c 'import numpy; from osgeo import gdal' \
 && node --version && gdal --version

ENTRYPOINT []
CMD ["cut-aerial"]
