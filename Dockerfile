# HIVE — single image, runtime role picked by HIVE_MODE
#
# v0.7.2 slim pass: image dropped from ~10 GB to ~1-2 GB by:
#   1. Installing torch CPU wheels explicitly (saves ~1.5-2 GB; default
#      sentence-transformers pulls CUDA wheels we don't use).
#   2. Skipping npm devDependencies in production.
#   3. Cleaning pip / apt caches in the same RUN layer they were created.
#
# Backed by ghcr.io/capybarist/hive:latest. Same image serves all three
# HIVE_MODE values; the runtime decides what to start (see hive.sh).
FROM node:20-slim

# Python runtime + curl for healthcheck. apt lists cleaned in the same
# layer so they don't bloat the image. `python-is-python3` makes
# `#!/usr/bin/env python` work for callers that don't qualify python3.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip python-is-python3 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /hive

# ── Node deps ────────────────────────────────────────────────────────────────
# Copy only manifests first so this layer caches across source-only changes.
# We do a full `npm install` (not --omit=dev) because the runtime uses tsx
# to load .ts files directly — tsx lives in devDependencies. Moving tsx to
# dependencies would let us prune dev, but that's a separate cleanup.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/api/package.json packages/api/
COPY packages/embeddings/requirements.txt packages/embeddings/
RUN npm install \
    && npm cache clean --force

# ── Python deps ──────────────────────────────────────────────────────────────
# Install torch FIRST from the CPU-only wheel index so sentence-transformers
# (installed next) picks up the existing CPU build instead of pulling the
# default CUDA-12 wheels (~2 GB). `--break-system-packages` is required on
# node:20-slim because of PEP 668; we accept that since the container has no
# other Python tenant.
RUN pip3 install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        --break-system-packages \
        torch \
    && pip3 install --no-cache-dir \
        --break-system-packages \
        -r packages/embeddings/requirements.txt \
    && rm -rf /root/.cache/pip

# ── Source ───────────────────────────────────────────────────────────────────
COPY . .

# Keep topic_tree.json outside the data volume so it survives the mount.
# The code checks resolve(HIVE_DATA_DIR, '../topic_tree.json') = /hive/topic_tree.json.
RUN cp data/topic_tree.json topic_tree.json

# Runtime data lives in a volume
VOLUME ["/hive/data"]

EXPOSE 8080 7700

ENV HIVE_PORT=8080
ENV HIVE_EMBEDDER_PORT=7700
ENV HIVE_DATA_DIR=/hive/data/bee

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:8080/api/status || exit 1

CMD ["bash", "hive.sh"]
