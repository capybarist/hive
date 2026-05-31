export * from './node_identity.js';
export { KnowledgeStore } from './knowledge_store.js';
export type { QueryFilter } from './knowledge_store.js';
export { HiveP2PNode, PUBLIC_TOPIC, topicFromString, topicFromHex } from './p2p_node.js';
export { TopicsRegistry, REGISTRY_TOPIC } from './topics_registry.js';
export type { TopicCard, TopicSummary } from './topics_registry.js';
export { ClaimRegistry } from './claim_registry.js';
export { PeerRegistry } from './peer_registry.js';
export type { PeerMeta } from './p2p_node.js';
export { createLLMProvider, isLLMConfigured, validateLLMKey } from './llm_provider.js';
export type { LLMProvider, LLMMessage, MessagePart, ToolDef, ToolCall, GenerateOptions, GenerateResult } from './llm_provider.js';
export { buildDeclaredSources } from './bee_manifest.js';
export type { BeeManifest, DeclaredSource } from './bee_manifest.js';

// v0.8 — canonical Fragment data model + signed-vector builder + content hash.
export { buildSignedFragmentV08, verifyFragmentV08 } from './fragment_v08.js';
export { contentHash, normalizeForHash } from './content_hash.js';
export {
  EMBEDDING_MODEL, EMBEDDING_DIM, SCHEMA_VERSION, CHUNKER_VERSION, DEFAULT_TTL,
} from './schema_v08.js';
export type { FragmentV08, FragmentV08Input, FragmentStatus } from './schema_v08.js';
