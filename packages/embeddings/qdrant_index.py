"""
Qdrant-backed vector index — drop-in replacement for VectorIndex.

Used by the HIVE aggregator (EMBEDDER_BACKEND=qdrant). Regular BEEs
continue using VectorIndex (HNSW in-process). Both expose the same
interface so EmbeddingEngine and api_server work with either.
"""
from __future__ import annotations

import hashlib
import uuid
from typing import Any

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

DIMENSION = 384  # all-MiniLM-L6-v2
COLLECTION = "hive_fragments"


class QdrantIndex:
    """
    Wraps Qdrant for persistent, filterable vector storage.

    The aggregator indexes fragments from every BEE it discovers,
    so this collection can grow to millions of entries over time.
    Unlike the in-process HNSW index, Qdrant survives restarts and
    can be queried by multiple processes simultaneously.
    """

    def __init__(self, url: str = "http://localhost:6333", collection: str = COLLECTION):
        self._client = QdrantClient(url=url, timeout=30)
        self._collection = collection
        self._dim = DIMENSION
        # In-memory dedup set — populated from Qdrant on startup.
        # Fine for v0.3 (< 1M fragments). Replace with bloom filter at scale.
        self._known_ids: set[str] = set()
        self._ensure_collection()
        self._load_known_ids()

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _to_point_id(self, fragment_id: str) -> str:
        """Deterministic UUID from an arbitrary fragment ID string."""
        return str(uuid.UUID(hashlib.md5(fragment_id.encode()).hexdigest()))

    def _ensure_collection(self) -> None:
        existing = {c.name for c in self._client.get_collections().collections}
        if self._collection not in existing:
            self._client.create_collection(
                collection_name=self._collection,
                vectors_config=VectorParams(size=self._dim, distance=Distance.COSINE),
            )
            print(f"[qdrant] Created collection '{self._collection}' (dim={self._dim})")
        else:
            count = self._client.get_collection(self._collection).points_count or 0
            print(f"[qdrant] Connected to '{self._collection}' ({count} points)")

    def _load_known_ids(self) -> None:
        """Scroll all existing fragment IDs into memory for fast dedup."""
        try:
            offset = None
            loaded = 0
            while True:
                results, offset = self._client.scroll(
                    collection_name=self._collection,
                    limit=1_000,
                    offset=offset,
                    with_payload=["id"],
                    with_vectors=False,
                )
                for r in results:
                    fid = (r.payload or {}).get("id")
                    if fid:
                        self._known_ids.add(fid)
                loaded += len(results)
                if offset is None:
                    break
            print(f"[qdrant] Loaded {loaded} known fragment IDs")
        except Exception as e:
            print(f"[qdrant] Could not pre-load IDs: {e}")

    # ── Public interface (mirrors VectorIndex) ────────────────────────────────

    def add(self, id: str, vector: np.ndarray, metadata: dict | None = None) -> None:
        self._client.upsert(
            collection_name=self._collection,
            points=[PointStruct(
                id=self._to_point_id(id),
                vector=vector.astype(np.float32).tolist(),
                payload={"id": id, **(metadata or {})},
            )],
        )
        self._known_ids.add(id)

    def query(
        self,
        vector: np.ndarray,
        k: int = 5,
        filters: dict[str, Any] | None = None,
    ) -> list[dict]:
        """
        Semantic search with optional exact-match filters.
        filters = {"topic": "science/physics", "node_id": "node_abc"}
        """
        qdrant_filter = None
        if filters:
            conditions = [
                FieldCondition(key=key, match=MatchValue(value=val))
                for key, val in filters.items()
                if val is not None
            ]
            if conditions:
                qdrant_filter = Filter(must=conditions)

        # v0.7.2.4: switched from query_points() back to search().
        #
        # query_points() was added in qdrant-client 1.10 and calls the
        # /collections/{name}/points/query endpoint introduced in Qdrant
        # SERVER 1.10. Our docker-compose pins qdrant/qdrant:v1.9.2; the
        # server returns 404 Not Found for that path, surfaced as
        # `UnexpectedResponse: 404` in the embedder's /search handler.
        # Net effect: /api/query always returned zero fragments and the
        # LLM fell back to "general knowledge" for every question, even
        # for content the queen had indexed.
        #
        # search() targets the older /collections/{name}/points/search
        # endpoint that's present in every Qdrant >= 1.0. Functionally
        # equivalent for our use (single dense-vector query, payload
        # filter, top-k limit). Upgrading the Qdrant server to 1.10+ is
        # the longer-term move; for now the client-side fix avoids the
        # risk of touching a collection with 100k+ live vectors.
        result = self._client.search(
            collection_name=self._collection,
            query_vector=vector.astype(np.float32).tolist(),
            limit=k,
            with_payload=True,
            query_filter=qdrant_filter,
        )
        return [{"score": round(h.score, 4), **(h.payload or {})} for h in result]

    def list_all(self, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        """
        Paginated fragment listing.
        Returns (page_items, total_count).
        Note: fetches up to 10k for pagination — optimize with Qdrant
        scroll cursors if this becomes a bottleneck.
        """
        try:
            results, _ = self._client.scroll(
                collection_name=self._collection,
                limit=min(offset + limit, 10_000),
                with_payload=True,
                with_vectors=False,
            )
            total = self.size
            page = results[offset:offset + limit]
            return [r.payload or {} for r in page], total
        except Exception:
            return [], 0

    def aggregator_stats(self) -> dict:
        """Summary stats exposed by the aggregator /stats endpoint."""
        try:
            count = self.size
            # Unique BEEs and topics via Qdrant facet-style scroll
            bee_ids: set[str] = set()
            topics: set[str] = set()
            offset = None
            while True:
                results, offset = self._client.scroll(
                    collection_name=self._collection,
                    limit=1_000,
                    offset=offset,
                    with_payload=["node_id", "topic"],
                    with_vectors=False,
                )
                for r in results:
                    p = r.payload or {}
                    if p.get("node_id"):
                        bee_ids.add(p["node_id"])
                    if p.get("topic"):
                        topics.add(p["topic"])
                if offset is None:
                    break
            return {
                "fragments": count,
                "bees": len(bee_ids),
                "topics": len(topics),
            }
        except Exception as e:
            return {"fragments": self.size, "bees": 0, "topics": 0, "error": str(e)}

    def save(self, base_path: str) -> None:
        pass  # Qdrant persists to its own storage directory

    def load(self, base_path: str) -> None:
        pass  # Qdrant loads from its own storage on startup

    # ── Compatibility shims for code that introspects VectorIndex internals ──

    @property
    def _id_to_label(self) -> dict[str, int]:
        """Used by api_server.py for dedup checks (if id in index._id_to_label)."""
        return {fid: 1 for fid in self._known_ids}

    @property
    def _meta(self) -> dict:
        """VectorIndex stores metadata here; Qdrant stores it in payloads."""
        return {}

    @property
    def size(self) -> int:
        try:
            return self._client.get_collection(self._collection).points_count or 0
        except Exception:
            return len(self._known_ids)
