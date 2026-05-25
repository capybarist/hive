from __future__ import annotations

import numpy as np
from sentence_transformers import SentenceTransformer

from hnsw_index import VectorIndex

MODEL_NAME = "all-MiniLM-L6-v2"


class EmbeddingEngine:
    def __init__(self, index: VectorIndex | None = None):
        self.model = SentenceTransformer(MODEL_NAME)
        self.index = index if index is not None else VectorIndex()

    def embed(self, text: str) -> np.ndarray:
        return self.model.encode(text, normalize_embeddings=True)

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        """
        Vectorise N texts in one sentence-transformers call. ~25× faster than
        N separate embed() calls because:
          - One model forward pass (batch tensor on the same GPU/CPU).
          - One Python<->C++ round-trip instead of N.
        Returns a (N, dim) ndarray; caller indexes per-item.
        """
        if not texts:
            return np.zeros((0, 384), dtype=np.float32)
        return self.model.encode(texts, normalize_embeddings=True, batch_size=64)

    def add(self, id: str, text: str, metadata: dict | None = None) -> None:
        vector = self.embed(text)
        meta = {**(metadata or {}), "text": text}
        self.index.add(id, vector, meta)

    def add_batch(self, items: list[dict]) -> int:
        """
        Bulk add. Each item is {id, text, metadata?}. The embedder runs a
        single batch encode and the index ingests all vectors at once
        (QdrantIndex.upsert_batch — one HTTP call to Qdrant; HNSW falls
        back to per-item add but still saves the encode round-trips).
        Returns the count of newly indexed items (skips ids already present).
        """
        if not items:
            return 0
        texts = [it["text"] for it in items]
        vectors = self.embed_batch(texts)
        prepared = []
        for vec, it in zip(vectors, items):
            meta = {**(it.get("metadata") or {}), "text": it["text"]}
            prepared.append((it["id"], vec, meta))

        if hasattr(self.index, "upsert_batch"):
            return self.index.upsert_batch(prepared)
        # Fallback for HNSW or any other VectorIndex without batch support.
        added = 0
        for id_, vec, meta in prepared:
            if id_ in getattr(self.index, "_id_to_label", {}):
                continue
            self.index.add(id_, vec, meta)
            added += 1
        return added

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        vector = self.embed(query)
        return self.index.query(vector, top_k)
