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

    def add(self, id: str, text: str, metadata: dict | None = None) -> None:
        vector = self.embed(text)
        meta = {**(metadata or {}), "text": text}
        self.index.add(id, vector, meta)

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        vector = self.embed(query)
        return self.index.query(vector, top_k)
