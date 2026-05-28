# HIVE v0.8 — single image, runtime role picked by HIVE_MODE.
#
# v0.8 strips the Python embedder + Qdrant client. Everything is Node now:
# e5-base ONNX int8 via @huggingface/transformers, vectors in LanceDB.
# Float16Array (used for fp16 vector encoding) requires Node 22+.

FROM node:22-slim

# curl for the docker HEALTHCHECK + ca-certificates so the ONNX model fetch
# from huggingface.co works at build/runtime. No Python, no apt-y heavy lifting.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /hive

# ── Node deps ───────────────────────────────────────────────────────────────
# Copy manifests first so this layer caches across source-only changes.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/api/package.json packages/api/
COPY packages/embeddings-node/package.json packages/embeddings-node/
RUN npm install

# ── Source ──────────────────────────────────────────────────────────────────
COPY . .

# topic_tree.json lives outside the data volume so it survives mounts.
# The code looks for /hive/topic_tree.json regardless of HIVE_DATA_DIR.
RUN cp data/topic_tree.json topic_tree.json

# ── Warm the e5-base ONNX int8 model at build time ──────────────────────────
# Otherwise every fresh container re-downloads ~200 MB on first request,
# which makes the first /api/query (or first bee extraction) a 30s wait.
# Cached under /root/.cache/huggingface so it's part of the image layer.
RUN cd packages/embeddings-node \
  && node --import tsx/esm -e "import('./src/embedder.js').then(m => m.warmup()).then(() => console.log('e5-base ONNX cached')).catch(e => { console.error(e); process.exit(1); })"

VOLUME ["/hive/data"]

EXPOSE 8080

ENV HIVE_PORT=8080
ENV HIVE_DATA_DIR=/hive/data/bee

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:8080/api/status || exit 1

CMD ["bash", "hive.sh"]
