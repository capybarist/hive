from __future__ import annotations

import numpy as np
from sentence_transformers import SentenceTransformer

from hnsw_index import VectorIndex

MODEL_NAME = "all-MiniLM-L6-v2"


def strip_surrogates(s: str) -> str:
    """Remove lone UTF-16 surrogate code points (U+D800–U+DFFF) from a string.

    v0.7.6.8 — bee-1 extracts Wikipedia text containing 4-byte UTF-8
    characters (Gothic 𐌸, Brahmic scripts, emoji, …). Somewhere in the
    extractor a surrogate pair gets split mid-character and a lone
    surrogate (e.g. `\\ud804`, `\\udf3c`) ends up in the fragment text.
    Lone surrogates are valid in a Python `str` but cannot be encoded to
    UTF-8, so they blow up in two places downstream:
      1. the HF tokenizer (`TextEncodeInput must be Union[...]`)
      2. the Qdrant client's `model_dump_json` (`UnicodeEncodeError:
         surrogates not allowed`) — this one is the worse failure because
         it fails the WHOLE qdrant upsert, returns 500, and the queen
         never advances its replication cursor past the poison fragment
         (infinite retry of the same batch → catch-up frozen).
    Stripping them is lossless for every legitimate character: a properly
    decoded UTF-8 codepoint is a single `str` element, never a surrogate.
    """
    if not s:
        return s
    return "".join(ch for ch in s if not 0xD800 <= ord(ch) <= 0xDFFF)


def sanitize_meta(meta: dict) -> dict:
    """Strip lone surrogates from every string value in a metadata dict.

    v0.7.7.3 — v0.7.7.2 only cleaned the `text` field, but the poison
    surrogate (\\ud804) lived in ANOTHER payload field (a fragment title
    in this case). The Qdrant client serializes the WHOLE payload to
    JSON, so a surrogate in any string value fails the upsert and
    freezes the cursor. Clean every string value (one level deep — the
    queen's payloads are flat).
    """
    out = {}
    for k, v in meta.items():
        out[k] = strip_surrogates(v) if isinstance(v, str) else v
    return out


class EmbeddingEngine:
    def __init__(self, index: VectorIndex | None = None):
        self.model = SentenceTransformer(MODEL_NAME)
        self.index = index if index is not None else VectorIndex()

    def embed(self, text: str) -> np.ndarray:
        return self.model.encode(text, normalize_embeddings=True)

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        """Vectorise N texts in one model forward pass (~25× faster than N
        separate embed() calls). Returns a (N, dim) ndarray."""
        if not texts:
            return np.zeros((0, 384), dtype=np.float32)
        return self.model.encode(texts, normalize_embeddings=True, batch_size=64)

    def add(self, id: str, text: str, metadata: dict | None = None) -> None:
        text = strip_surrogates(text)
        vector = self.embed(text)
        meta = {**sanitize_meta(metadata or {}), "text": text}
        self.index.add(id, vector, meta)

    def add_batch(self, items: list[dict]) -> int:
        """Bulk add — one batch encode + one index upsert (Qdrant) or per-item
        adds (HNSW fallback). Skips ids already present. Returns count newly
        indexed. The queen's watchRemoteCore uses this to keep up with the
        bee's continuous output.

        v0.7.6.5 — Filter known IDs BEFORE embedding. During queen catch-up
        replay 99% of the stream is fragments already in Qdrant; the previous
        version still ran sentence-transformers.encode on every text and only
        deduped in upsert_batch. On a 3.7 GB Hetzner box that wasted enough
        CPU + RAM to OOM-kill the embedder every ~2 h. Filtering first
        collapses catch-up cost to a per-id set lookup."""
        if not items:
            return 0
        # Backend-agnostic known-id snapshot. qdrant_index keeps
        # `_known_ids` populated from disk at startup; hnsw_index uses
        # `_id_to_label`. Either way it's an in-memory set keyed by
        # fragment id — `id in known` is O(1).
        known = getattr(self.index, "_known_ids", None)
        if known is None:
            known = getattr(self.index, "_id_to_label", {})
        # Also defend against malformed items here: the queen has its own
        # client-side guard, but a 500 on the whole batch hurts much more
        # than silently dropping one bad item, so re-check id + non-empty
        # string text before letting them near sentence-transformers.
        # v0.7.6.8 — strip lone surrogates from text up front. The text we
        # carry forward (for both embedding AND the qdrant payload) is the
        # sanitised version, so the poison fragment can no longer fail the
        # qdrant JSON serialization and freeze the queen's cursor.
        fresh = []
        for it in items:
            if not (isinstance(it.get("id"), str) and it["id"]):
                continue
            if it["id"] in known:
                continue
            raw = it.get("text")
            if not (isinstance(raw, str) and raw.strip()):
                continue
            clean = strip_surrogates(raw)
            if not clean.strip():
                continue
            fresh.append({**it, "text": clean})
        if not fresh:
            return 0
        texts = [it["text"] for it in fresh]
        try:
            vectors = self.embed_batch(texts)
            prepared = [
                (it["id"], vec, {**sanitize_meta(it.get("metadata") or {}), "text": it["text"]})
                for vec, it in zip(vectors, fresh)
            ]
        except Exception as e:
            # v0.7.6.7 — when the tokenizer still chokes on a text inside a
            # batch (oversized input, exotic combining marks), one bad item
            # would otherwise lose all 20. Re-process per-item so the good
            # ones survive; log a repr() of any individual failure.
            print(f"[add_batch] embed_batch failed ({type(e).__name__}: {e}); falling back to per-item")
            prepared = []
            for it in fresh:
                try:
                    vec = self.embed(it["text"])
                    prepared.append((
                        it["id"], vec,
                        {**sanitize_meta(it.get("metadata") or {}), "text": it["text"]},
                    ))
                except Exception as ee:
                    sample = repr(it["text"])[:120]
                    print(f"[add_batch] dropping bad item id={it['id']!r} text={sample} err={type(ee).__name__}: {ee}")
        if hasattr(self.index, "upsert_batch"):
            return self.index.upsert_batch(prepared)
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
