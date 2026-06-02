export { runAutonomousExtraction } from './autonomous_extractor.js';
export type { ExtractionResult, BudgetConfig } from './autonomous_extractor.js';

// v0.9 — ForagerRegistry: the single source of truth for known sources. The API
// derives manifest validation (`validAdapterIds`) and the Settings source-picker
// (`/api/sources` ← `listDescriptors`) from these instead of hardcoded lists.
export {
  registerForager, getForager, listForagers,
  listDescriptors, validAdapterIds, describeForager,
} from './forager/registry.js';
export type {
  ForagerSource, ForagerDescriptor, ForagerKind, ForagerScopeSchema, ScopeInput,
} from './forager/source.js';
