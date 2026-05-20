from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from usearch.index import Index

DIMENSION = 384  # all-MiniLM-L6-v2 output dimension


class VectorIndex:
    def __init__(self, dim: int = DIMENSION, max_elements: int = 100_000):
        self.dim = dim
        self._index = Index(ndim=dim, metric="cos", dtype="f32", connectivity=16, expansion_add=200, expansion_search=50)
        self._meta: dict[int, dict] = {}
        self._id_to_label: dict[str, int] = {}
        self._next_label = 0

    def add(self, id: str, vector: np.ndarray, metadata: dict | None = None) -> None:
        # Upsert semantics: if this id was already indexed (re-hydration after
        # container restart, supersede, or forager bootstrap re-fetch), update
        # the metadata but skip re-adding to usearch — the index already has
        # the vector under the old label, and usearch refuses duplicate keys.
        existing_label = self._id_to_label.get(id)
        if existing_label is not None:
            self._meta[existing_label] = {"id": id, **(metadata or {})}
            return
        # Pick the next free label. If the underlying usearch index was loaded
        # from disk while _next_label was reset to 0 (meta.json missing or
        # out of sync), the C++ index will reject the label as duplicate.
        # Retry with larger labels until usearch accepts.
        label = self._next_label
        for _ in range(5):
            try:
                self._index.add(label, vector.astype(np.float32))
                break
            except Exception as e:
                if "Duplicate" in str(e):
                    label = max(label + 1, len(self._index))
                    continue
                raise
        self._id_to_label[id] = label
        self._meta[label] = {"id": id, **(metadata or {})}
        self._next_label = label + 1

    def query(self, vector: np.ndarray, k: int = 5) -> list[dict]:
        if self._next_label == 0:
            return []
        k = min(k, self._next_label)
        matches = self._index.search(vector.astype(np.float32), k)
        results = []
        for label, dist in zip(matches.keys.tolist(), matches.distances.tolist()):
            meta = self._meta.get(int(label), {})
            results.append({"score": round(float(1 - dist), 4), **meta})
        return results

    def save(self, base_path: str) -> None:
        path = Path(base_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._index.save(str(path))
        meta_path = path.with_suffix(".meta.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "meta": {str(k): v for k, v in self._meta.items()},
                    "id_to_label": self._id_to_label,
                    "next_label": self._next_label,
                    "dim": self.dim,
                },
                f,
                indent=2,
            )

    def load(self, base_path: str) -> None:
        path = Path(base_path)
        self._index.load(str(path))
        meta_path = path.with_suffix(".meta.json")
        with open(meta_path, encoding="utf-8") as f:
            data = json.load(f)
        self._meta = {int(k): v for k, v in data["meta"].items()}
        self._id_to_label = data["id_to_label"]
        self._next_label = data["next_label"]
        self.dim = data["dim"]

    @property
    def size(self) -> int:
        return self._next_label
