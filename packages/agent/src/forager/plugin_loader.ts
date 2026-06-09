/**
 * External forager plugins — load third-party `ForagerSource`s from npm.
 *
 * The {@link ForagerRegistry} is the single registration point; built-in
 * adapters are listed in `registry.ts::ALL`. This loader lets an operator add
 * connectors WITHOUT forking HIVE: install an npm package that exports a
 * `ForagerSource` (or a `registerForagers(api)` hook), name it in
 * `HIVE_FORAGER_PLUGINS`, and on boot it is `import()`ed, validated, and pushed
 * into the registry via `registerForager()`. From there the descriptor flows to
 * `/api/sources`, the Settings picker, manifest validation and the dashboard —
 * exactly like a built-in.
 *
 * SECURITY: a plugin is ordinary npm code and runs with the node's full
 * privileges (like any dependency). Only list packages you trust. The package
 * must already be installed in the node's `node_modules` (add it as a dep of
 * your `@capybaralabs/hive` install, or bake it into a derived Docker image).
 *
 * A plugin module may expose its forager(s) in any of these shapes:
 *   - `export default foragerSource`
 *   - `export const forager = …` / `export const source = …`
 *   - one or more named exports that satisfy the ForagerSource shape
 *   - `export function registerForagers(api) { api.registerForager(…) }`
 *     (preferred when a single package ships several adapters)
 */
import { registerForager } from './registry.js';
import type { ForagerSource } from './source.js';

/** Parse `HIVE_FORAGER_PLUGINS` — comma/whitespace-separated npm specifiers. */
export function pluginSpecifiers(env: string | undefined = process.env.HIVE_FORAGER_PLUGINS): string[] {
  return (env ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** Duck-type guard: looks like a usable ForagerSource with a valid descriptor. */
function isForagerSource(x: unknown): x is ForagerSource {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  if (typeof s.describe !== 'function' || typeof s.fetch !== 'function' || typeof s.owns !== 'function') {
    return false;
  }
  try {
    const d = (s.describe as () => { id?: unknown }).call(x);
    return !!d && typeof d.id === 'string' && (d.id as string).length > 0;
  } catch {
    return false;
  }
}

/** Pull every ForagerSource-shaped value out of a loaded module's exports. */
function extractForagers(mod: Record<string, unknown>): ForagerSource[] {
  const found: ForagerSource[] = [];
  const seen = new Set<unknown>();
  const consider = (v: unknown) => {
    if (v && !seen.has(v) && isForagerSource(v)) { seen.add(v); found.push(v); }
  };
  consider(mod.default);
  consider(mod.forager);
  consider(mod.source);
  for (const v of Object.values(mod)) consider(v);
  if (mod.default && typeof mod.default === 'object') {
    for (const v of Object.values(mod.default as Record<string, unknown>)) consider(v);
  }
  return found;
}

export interface PluginLoadResult {
  loaded: { spec: string; ids: string[] }[];
  failed: { spec: string; error: string }[];
}

/**
 * Import, validate and register every plugin in `specifiers`. A failing plugin
 * is logged and skipped — one bad connector must never stop the node booting.
 */
export async function loadExternalForagers(
  specifiers: string[] = pluginSpecifiers(),
  log: (msg: string) => void = (m) => console.log(m),
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], failed: [] };
  for (const spec of specifiers) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      const hook =
        typeof mod.registerForagers === 'function' ? (mod.registerForagers as (api: { registerForager: typeof registerForager }) => unknown)
        : typeof (mod.default as Record<string, unknown> | undefined)?.registerForagers === 'function'
          ? ((mod.default as Record<string, unknown>).registerForagers as (api: { registerForager: typeof registerForager }) => unknown)
        : null;

      const ids: string[] = [];
      if (hook) {
        await hook({
          registerForager: (s: ForagerSource) => {
            if (!isForagerSource(s)) throw new Error('registerForagers hook passed a non-ForagerSource');
            registerForager(s);
            ids.push(s.describe().id);
          },
        });
        if (ids.length === 0) throw new Error('registerForagers hook registered nothing');
      } else {
        const foragers = extractForagers(mod);
        if (foragers.length === 0) {
          throw new Error('no ForagerSource export found (expected a default/forager/source export, or a registerForagers(api) hook)');
        }
        for (const f of foragers) { registerForager(f); ids.push(f.describe().id); }
      }

      result.loaded.push({ spec, ids });
      log(`   [forager-plugin] ${spec} → ${ids.join(', ')} ✓`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      result.failed.push({ spec, error });
      log(`   [forager-plugin] FAILED ${spec}: ${error}`);
    }
  }
  if (specifiers.length > 0) {
    log(`   ForagerRegistry plugins: ${result.loaded.length} loaded, ${result.failed.length} failed`);
  }
  return result;
}
