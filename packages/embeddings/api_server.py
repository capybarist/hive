from __future__ import annotations

import os
from pathlib import Path

_PORT = int(os.environ.get("HIVE_EMBEDDER_PORT", "7700"))

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from embedder import EmbeddingEngine
from hnsw_index import VectorIndex

_default_data = Path(__file__).resolve().parents[2] / "data" / "vectors"
DATA_DIR = Path(os.environ.get("HIVE_VECTORS_DIR", str(_default_data)))
INDEX_PATH = str(DATA_DIR / "hnsw.index")

app = FastAPI(title="HIVE Embeddings API", version="0.1.0")

index = VectorIndex()
engine = EmbeddingEngine(index=index)

# Load persisted index on startup
if Path(INDEX_PATH).exists():
    try:
        index.load(INDEX_PATH)
        print(f"[HIVE] Loaded {index.size} vectors from {INDEX_PATH}")
    except Exception as e:
        print(f"[HIVE] Could not load index: {e} — starting fresh")


def _save():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    index.save(INDEX_PATH)


class EmbedRequest(BaseModel):
    text: str


class AddRequest(BaseModel):
    id: str
    text: str
    metadata: dict = {}


class SearchRequest(BaseModel):
    query: str
    top_k: int = 5


@app.post("/embed")
def embed(req: EmbedRequest):
    vector = engine.embed(req.text)
    return {"vector": vector.tolist(), "dim": len(vector)}


@app.post("/add")
def add(req: AddRequest):
    # Skip if ID already indexed (prevents duplicates on restart/resync)
    if req.id in index._id_to_label:
        return {"ok": True, "id": req.id, "indexed": index.size, "skipped": True}
    engine.add(req.id, req.text, req.metadata)
    _save()
    return {"ok": True, "id": req.id, "indexed": index.size}


@app.post("/search")
def search(req: SearchRequest):
    results = engine.search(req.query, req.top_k)
    return {"results": results, "count": len(results)}


@app.get("/fragments")
def list_fragments(limit: int = 50, offset: int = 0):
    all_items = list(index._meta.values())
    page = all_items[offset : offset + limit]
    return {
        "total": len(all_items),
        "offset": offset,
        "limit": limit,
        "fragments": page,
    }


@app.get("/fragments/{fragment_id}")
def get_fragment(fragment_id: str):
    label = index._id_to_label.get(fragment_id)
    if label is None:
        raise HTTPException(status_code=404, detail="Fragment not found")
    return index._meta[label]


@app.get("/health")
def health():
    return {"status": "ok", "model": "all-MiniLM-L6-v2", "indexed": index.size}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=_PORT)
