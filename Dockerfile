# HIVE — single image, runtime role picked by HIVE_MODE
#
# v0.7.2.1: image slim pass kept narrow to the change that's safe to make.
# Only the torch CPU-wheel install survives from the v0.7.2 attempt; the
# apt --no-install-recommends and npm cache clean changes are reverted
# because they broke the rocksdb-native prebuild fetch — see CHANGELOG.
#
# Backed by ghcr.io/capybarist/hive:latest. Same image serves all three
# HIVE_MODE values; the runtime decides what to start (see hive.sh).
FROM node:20-slim

# Python for the embeddings server. Kept identical to the pre-v0.7.2.1
# working version — bringing back the implicit "recommends" packages
# is what restores the rocksdb-native prebuild fetch in `npm install`.
RUN apt-get update \
    && apt-get install -y python3 python3-pip python-is-python3 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /hive

# ── Node deps ────────────────────────────────────────────────────────────────
# Copy only manifests first so this layer caches across source-only changes.
# Plain `npm install` (no extra flags). `npm cache clean --force` was tried
# in v0.7.2 and removed — the cache layer is tiny relative to torch, and the
# clean step may have interfered with rocksdb-native's prebuild flow on the
# linux-x64 buildx target. Not worth the risk.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/api/package.json packages/api/
COPY packages/embeddings/requirements.txt packages/embeddings/
RUN npm install

# ── Python deps ──────────────────────────────────────────────────────────────
# Install torch FIRST from the CPU-only wheel index so sentence-transformers
# (installed next) picks up the existing CPU build instead of pulling the
# default CUDA-12 wheels (~2 GB — the bulk of the v0.7.2 slim pass).
# --break-system-packages is required on node:20-slim because of PEP 668;
# we accept that since the container has no other Python tenant.
RUN pip3 install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        --break-system-packages \
        torch \
    && pip3 install --no-cache-dir \
        --break-system-packages \
        -r packages/embeddings/requirements.txt

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
