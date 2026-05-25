from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_PORT = int(os.environ.get("HIVE_EMBEDDER_PORT", "7700"))

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from embedder import EmbeddingEngine

# ── Backend selection ─────────────────────────────────────────────────────────
# EMBEDDER_BACKEND=hnsw  (default) — in-process HNSW, regular BEE mode
# EMBEDDER_BACKEND=qdrant           — Qdrant, aggregator mode

BACKEND = os.environ.get("EMBEDDER_BACKEND", "hnsw").lower()
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "hive_fragments")

if BACKEND == "qdrant":
    from qdrant_index import QdrantIndex
    index = QdrantIndex(url=QDRANT_URL, collection=QDRANT_COLLECTION)
    print(f"[HIVE] Embedder backend: Qdrant @ {QDRANT_URL}")
else:
    from hnsw_index import VectorIndex
    _default_data = Path(__file__).resolve().parents[2] / "data" / "vectors"
    DATA_DIR = Path(os.environ.get("HIVE_VECTORS_DIR", str(_default_data)))
    INDEX_PATH = str(DATA_DIR / "hnsw.index")
    index = VectorIndex()
    if Path(INDEX_PATH).exists():
        try:
            index.load(INDEX_PATH)
            print(f"[HIVE] Loaded {index.size} vectors from {INDEX_PATH}")
        except Exception as e:
            print(f"[HIVE] Could not load index: {e} — starting fresh")
    print(f"[HIVE] Embedder backend: HNSW (in-process)")

engine = EmbeddingEngine(index=index)

app = FastAPI(title="HIVE Embeddings API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _save():
    if BACKEND == "hnsw":
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        index.save(INDEX_PATH)


# ── Request models ────────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    text: str


class AddRequest(BaseModel):
    id: str
    text: str
    metadata: dict = {}


class AddBatchItem(BaseModel):
    id: str
    text: str
    metadata: dict = {}


class AddBatchRequest(BaseModel):
    items: list[AddBatchItem]


class SearchRequest(BaseModel):
    query: str
    top_k: int = 5
    filters: dict[str, Any] | None = None  # aggregator mode: filter by topic, node_id, etc.


class CountByNodeRequest(BaseModel):
    node_ids: list[str]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.post("/embed")
def embed(req: EmbedRequest):
    vector = engine.embed(req.text)
    return {"vector": vector.tolist(), "dim": len(vector)}


@app.post("/add")
def add(req: AddRequest):
    if req.id in index._id_to_label:
        return {"ok": True, "id": req.id, "indexed": index.size, "skipped": True}
    engine.add(req.id, req.text, req.metadata)
    _save()
    return {"ok": True, "id": req.id, "indexed": index.size}


@app.post("/add_batch")
def add_batch(req: AddBatchRequest):
    """v0.7.5.1 — bulk add. The queen's watchRemoteCore buffers remote
    fragments and POSTs them here every ~500 ms or when the buffer hits
    the flush threshold. One HTTP round-trip + one sentence-transformers
    batch encode + one Qdrant upsert per request. ~25× faster than the
    per-fragment /add path."""
    items = [{"id": it.id, "text": it.text, "metadata": it.metadata} for it in req.items]
    added = engine.add_batch(items)
    _save()
    return {"ok": True, "submitted": len(items), "added": added, "indexed": index.size}


@app.post("/search")
def search(req: SearchRequest):
    vector = engine.embed(req.query)
    if BACKEND == "qdrant":
        results = index.query(vector, req.top_k, filters=req.filters)
    else:
        results = index.query(vector, req.top_k)
    return {"results": results, "count": len(results)}


@app.get("/fragments")
def list_fragments(limit: int = 50, offset: int = 0):
    if BACKEND == "qdrant":
        items, total = index.list_all(limit=limit, offset=offset)
        return {"total": total, "offset": offset, "limit": limit, "fragments": items}
    all_items = list(index._meta.values())
    page = all_items[offset:offset + limit]
    return {"total": len(all_items), "offset": offset, "limit": limit, "fragments": page}


@app.get("/fragments/{fragment_id}")
def get_fragment(fragment_id: str):
    if BACKEND == "qdrant":
        # Search by payload id field
        results, _ = index._client.scroll(
            collection_name=index._collection,
            scroll_filter={"must": [{"key": "id", "match": {"value": fragment_id}}]},
            limit=1,
            with_payload=True,
        )
        if not results:
            raise HTTPException(status_code=404, detail="Fragment not found")
        return results[0].payload
    label = index._id_to_label.get(fragment_id)
    if label is None:
        raise HTTPException(status_code=404, detail="Fragment not found")
    return index._meta[label]


@app.post("/count-by-node")
def count_by_node(req: CountByNodeRequest):
    """Return exact fragment count per node_id (used by /api/topics for accurate panel data)."""
    if BACKEND != "qdrant":
        return {nid: sum(1 for m in index._meta.values() if m.get("node_id") == nid) for nid in req.node_ids}
    return {nid: index.count_for_node(nid) for nid in req.node_ids}


@app.get("/stats")
def stats():
    """Aggregator-specific summary stats. Works in both backends."""
    if BACKEND == "qdrant":
        return {"backend": "qdrant", **index.aggregator_stats()}
    return {
        "backend": "hnsw",
        "fragments": index.size,
        "bees": None,
        "topics": None,
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": "all-MiniLM-L6-v2",
        "backend": BACKEND,
        "indexed": index.size,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=_PORT)
