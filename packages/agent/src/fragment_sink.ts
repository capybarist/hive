// HIVE v1.x — where a bee's signed fragments go after the pipeline.
//
// The forager pipeline (forage → chunk → embed → sign) is transport-agnostic;
// only the final "publish" step differs:
//   · p2p (default)  — KnowledgeStore appends to the local Hyperbee and the
//     queen pulls it over Hypercore replication.
//   · direct          — DirectTransport batches fragments and POSTs them to a
//     queen's /internal/ingest over plain HTTP (docs/direct-mode.md).
// KnowledgeStore satisfies this interface structurally — no adapter needed.
import type { BeeManifest, FragmentV08 } from '@hive/core';

export interface FragmentSink {
  /** Publish one signed fragment (may buffer — see flush()). */
  save(frag: FragmentV08): Promise<void>;
  /** Freshness lookup for the TTL skip; only extracted_at is consulted. */
  get(id: string): Promise<Pick<FragmentV08, 'extracted_at'> | null>;
  /** Cumulative count of locally produced fragments (dashboards/logs). */
  readonly localFragmentCount: number;
  /** The manifest driving source selection (null before first publish). */
  getLocalManifest(): Promise<BeeManifest | null>;
  /** Deliver anything still buffered. Optional: the Hyperbee path is unbuffered. */
  flush?(): Promise<void>;
}
