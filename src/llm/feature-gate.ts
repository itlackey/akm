/**
 * Per-feature LLM gates (v1 spec §14).
 *
 * Every bounded in-tree LLM call site in akm is addressed by exactly one
 * feature key under `llm.features.*`. This module is the single seam call
 * sites use to ask "should I run?" and "if I run and fail, what do I return?"
 *
 * The seam is intentionally tiny:
 *
 *   - `isLlmFeatureEnabled(config, feature)` — pure predicate, no side
 *     effects, no I/O. Returns `true` only when the feature flag is the
 *     literal boolean `true` in config. Defaults are `false` per v1
 *     spec §14 — adding a flag to the schema is a non-event until the user
 *     opts in.
 *   - `tryLlmFeature(feature, config, fn, fallback, opts?)` — single-call
 *     wrapper that runs `fn()` only when the gate is open, enforces a hard
 *     timeout (default 30s — overridable per call), and returns `fallback`
 *     on disablement, throw, or timeout. The wrapper is referentially
 *     transparent for any given (gate-state, fn-result) pair: no module
 *     state is mutated.
 *
 * Statelessness invariant (v1 spec §14.4): nothing in this module holds
 * state across calls. There are no caches, no module-level singletons, no
 * persistent connections. The architecture seam test
 * (`tests/architecture/llm-stateless-seam.test.ts`) does not currently
 * inspect this file but the same rule applies — keep all exports as pure
 * functions.
 */

import type { AkmConfig, LlmFeatureFlags } from "../core/config";

/** Locked v1 feature keys (mirrors `LOCKED_LLM_FEATURE_KEYS` in config.ts). */
export type LlmFeatureKey = keyof LlmFeatureFlags;

/**
 * Pure predicate: is the named feature gate explicitly enabled in `config`?
 *
 * Returns `false` when:
 *   - the LLM block is missing,
 *   - the `features` block is missing,
 *   - the key is absent (defaults are `false`),
 *   - the key is set to `false`.
 */
export function isLlmFeatureEnabled(config: AkmConfig | undefined, feature: LlmFeatureKey): boolean {
  if (!config?.llm?.features) return false;
  return config.llm.features[feature] === true;
}

/**
 * Feature processes that default to `true` when absent from the v1
 * `llm.features` block. These mirror the original `=== false` guard semantics:
 * blocking only on explicit `false`, not on absence.
 */
const V1_DEFAULT_ENABLED: ReadonlySet<LlmFeatureKey> = new Set<LlmFeatureKey>(["memory_inference", "graph_extraction"]);

/**
 * Read the v1 `llm.features` gate for a known feature key, honouring the
 * per-key default: `true` for keys in {@link V1_DEFAULT_ENABLED}, `false` for
 * all others (opt-in).
 */
function isV1FeatureEnabled(config: AkmConfig, key: LlmFeatureKey): boolean {
  const configured = config.llm?.features?.[key];
  if (configured === true) return true;
  if (configured === false) return false;
  // Key absent — return the per-feature default.
  return V1_DEFAULT_ENABLED.has(key);
}

/**
 * v2 replacement for `isLlmFeatureEnabled`. Reads from the unified
 * `config.features[section][processName]` tree introduced in v2 config.
 *
 * Falls back to v1 `llm.features.*` when the specific `section` is absent
 * from the v2 features tree, enabling transparent backward compatibility with
 * v1 configs that still use `llm.features.*`.
 *
 * Bug fix: the fallback triggers on a missing *section*, not just a missing
 * top-level `features` object — so a partial v2 config (e.g. only
 * `features.improve` is present) still falls back to v1 for unregistered
 * sections like `features.search`.
 */
export function isProcessEnabled(section: string, processName: string, config: AkmConfig | undefined): boolean {
  if (!config) return false;

  // Check v2 features tree for this specific section.
  const featuresSection = (config as Record<string, unknown> & AkmConfig).features as
    | Record<string, unknown>
    | undefined;
  const sectionValue = featuresSection?.[section];
  if (sectionValue !== undefined) {
    // Section exists in the v2 tree — resolve through the v2 object.
    if (typeof sectionValue === "object" && sectionValue !== null && !Array.isArray(sectionValue)) {
      const entry = (sectionValue as Record<string, unknown>)[processName];
      // A process entry may be a plain boolean or an object with an `enabled` field.
      if (typeof entry === "boolean") return entry;
      if (typeof entry === "object" && entry !== null) {
        const enabled = (entry as Record<string, unknown>).enabled;
        if (typeof enabled === "boolean") return enabled;
        return true; // object present but no `enabled` key → treat as enabled
      }
      // Process not present in the section → disabled by default in v2.
      return false;
    }
    return false;
  }

  // Section absent from v2 tree — fall back to v1 llm.features gate for known v1 keys.
  const v1KeyMap: Record<string, Record<string, LlmFeatureKey>> = {
    index: {
      memory_inference: "memory_inference",
      graph_extraction: "graph_extraction",
    },
    improve: {
      feedback_distillation: "feedback_distillation",
    },
    search: {
      curate_rerank: "curate_rerank",
    },
  };
  const v1Key = v1KeyMap[section]?.[processName];
  if (v1Key) return isV1FeatureEnabled(config, v1Key);
  return false;
}

/** Optional knobs for `tryLlmFeature`. */
export interface TryLlmFeatureOptions {
  /**
   * Hard timeout in milliseconds. Defaults to 30_000 (30s) per the v1 spec
   * §14.2 "every LLM call site must enforce a hard timeout" rule. Pass `0`
   * or a negative value to disable the wrapper-level timeout (the underlying
   * `fn` may still time out via its own transport timeout).
   */
  timeoutMs?: number;
  /**
   * Optional warning sink. Receives a structured `{ feature, reason, error }`
   * record on every fallback. Default: the wrapper is silent. Call sites
   * that want to surface a structured `warnings` entry (per spec §14.2)
   * should pass a sink and forward into their command result.
   */
  onFallback?: (event: TryLlmFeatureFallbackEvent) => void;
}

/** Reason a `tryLlmFeature` invocation took the fallback path. */
export type TryLlmFeatureFallbackReason = "disabled" | "timeout" | "error";

/** Payload passed to `TryLlmFeatureOptions.onFallback`. */
export interface TryLlmFeatureFallbackEvent {
  feature: LlmFeatureKey;
  reason: TryLlmFeatureFallbackReason;
  /** Set when `reason === "error"` or `"timeout"`. */
  error?: Error;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run `fn()` only if `isLlmFeatureEnabled(config, feature)` is `true`. On
 * disablement, throw, or timeout, return `fallback` (or — if it is a
 * thunk — the value produced by calling it).
 *
 * The fallback may be a value or a synchronous/async function returning a
 * value. The thunk form lets call sites encode "run the deterministic
 * pipeline" without paying for it in the success path:
 *
 * ```ts
 * const ranked = await tryLlmFeature(
 *   "curate_rerank",
 *   config,
 *   () => llmRerank(candidates),
 *   () => deterministicRerank(candidates),
 * );
 * ```
 */
export async function tryLlmFeature<T>(
  feature: LlmFeatureKey,
  config: AkmConfig | undefined,
  fn: () => Promise<T> | T,
  fallback: T | (() => Promise<T> | T),
  opts?: TryLlmFeatureOptions,
): Promise<T> {
  const resolveFallback = async (): Promise<T> =>
    typeof fallback === "function" ? await (fallback as () => Promise<T> | T)() : fallback;

  if (!isLlmFeatureEnabled(config, feature)) {
    opts?.onFallback?.({ feature, reason: "disabled" });
    return resolveFallback();
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    if (timeoutMs <= 0) {
      return await fn();
    }
    return await runWithTimeout(fn, timeoutMs, feature);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const reason: TryLlmFeatureFallbackReason = error instanceof LlmFeatureTimeoutError ? "timeout" : "error";
    opts?.onFallback?.({ feature, reason, error });
    return resolveFallback();
  }
}

/** Specific error class so call sites and the wrapper can tell timeouts apart from generic throws. */
export class LlmFeatureTimeoutError extends Error {
  readonly feature: LlmFeatureKey;
  readonly timeoutMs: number;
  constructor(feature: LlmFeatureKey, timeoutMs: number) {
    super(`LLM feature "${feature}" timed out after ${timeoutMs}ms.`);
    this.name = "LlmFeatureTimeoutError";
    this.feature = feature;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function runWithTimeout<T>(fn: () => Promise<T> | T, timeoutMs: number, feature: LlmFeatureKey): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new LlmFeatureTimeoutError(feature, timeoutMs)), timeoutMs);
      Promise.resolve()
        .then(() => fn())
        .then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
