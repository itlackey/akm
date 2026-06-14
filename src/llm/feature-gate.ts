// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-feature LLM gates.
 *
 * Every bounded in-tree LLM call site in akm is addressed by exactly one
 * feature key. This module is the single seam call sites use to ask
 * "should I run?" and "if I run and fail, what do I return?".
 *
 * The seam is intentionally tiny:
 *
 *   - `isLlmFeatureEnabled(config, feature)` — pure predicate, no side
 *     effects, no I/O.
 *   - `tryLlmFeature(feature, config, fn, fallback, opts?)` — single-call
 *     wrapper that runs `fn()` only when the gate is open, enforces a hard
 *     timeout (default 600s — overridable per call via `opts.timeoutMs`),
 *     and returns `fallback` on disablement, throw, or timeout.
 *
 * The 0.8.0 config shape replaced the legacy `llm.features.*` /
 * `features.<section>.*` trees with the unified
 * `profiles.improve.default.processes.*`, `index.*`, and `search.*` shape.
 * The legacy `LlmFeatureKey` strings (`memory_inference`, etc.) are kept here
 * as a stable external API so call sites do not need to know where each gate
 * lives in the config tree — that mapping is private to this module.
 */

import type { AkmConfig } from "../core/config/config";

/** Locked v1 feature keys, kept for backward-compat at the call-site API level. */
export type LlmFeatureKey =
  | "memory_consolidation"
  | "distill"
  | "memory_inference"
  | "graph_extraction"
  | "metadata_enhance"
  | "curate_rerank"
  | "lesson_quality_gate"
  | "proposal_quality_gate"
  | "memory_contradiction_detection"
  | "session_extraction";

/**
 * For each feature key, return the effective enabled state by reading the
 * new 0.8.0 config shape. Defaults match the legacy `LlmFeatureFlags` docstrings.
 */
// Defaults below mirror the legacy LlmFeatureFlags docstrings so existing
// behaviour is preserved when a config is silent on a flag.
const FEATURE_LOCATION: Record<LlmFeatureKey, (cfg: AkmConfig) => boolean> = {
  // Legacy default: false → memory_consolidation only runs when explicitly enabled
  // (either via the user's improve profile or the built-in `default` profile).
  memory_consolidation: (cfg) => cfg.profiles?.improve?.default?.processes?.consolidate?.enabled ?? false,
  // 0.8.0 unified gate: replaces the legacy `feedback_distillation` key.
  // The orchestration gate (planner) and the LLM-call gate now share the same
  // source of truth: `processes.distill.enabled`. Default: true (matches the
  // built-in `default` profile).
  distill: (cfg) => cfg.profiles?.improve?.default?.processes?.distill?.enabled ?? true,
  // Legacy default: true
  memory_inference: (cfg) => cfg.profiles?.improve?.default?.processes?.memoryInference?.enabled ?? true,
  // Legacy default: true
  graph_extraction: (cfg) => cfg.profiles?.improve?.default?.processes?.graphExtraction?.enabled ?? true,
  // Legacy default: false
  metadata_enhance: (cfg) => cfg.index?.metadataEnhance?.enabled ?? false,
  // Legacy default: false
  curate_rerank: (cfg) => cfg.search?.curateRerank?.enabled ?? false,
  // Legacy default: false
  lesson_quality_gate: (cfg) => cfg.profiles?.improve?.default?.processes?.distill?.qualityGate?.enabled ?? false,
  // Legacy default: false
  proposal_quality_gate: (cfg) => cfg.profiles?.improve?.default?.processes?.reflect?.qualityGate?.enabled ?? false,
  // Legacy default: false
  memory_contradiction_detection: (cfg) =>
    cfg.profiles?.improve?.default?.processes?.consolidate?.contradictionDetection?.enabled ?? false,
  // Default: true. Session extraction's real on/off control now lives at the
  // orchestration layer (the active improve profile's `processes.extract.enabled`
  // or an explicit `akm extract` invocation). Reading only
  // `profiles.improve.default.processes.extract.enabled` here made non-default
  // profiles like `reflect-distill` lie: extract could be enabled on the active
  // profile yet still be hard-disabled globally. Keep the feature gate itself
  // always on and let the caller's process/profile gate decide whether to run.
  session_extraction: (_cfg) => true,
};

/**
 * Pure predicate: is the named feature gate enabled in `config`?
 *
 * Reads from the unified 0.8.0 config shape. Defaults follow the legacy
 * `LlmFeatureFlags` docstring defaults.
 */
export function isLlmFeatureEnabled(config: AkmConfig | undefined, feature: LlmFeatureKey): boolean {
  if (!config) return false;
  const resolver = FEATURE_LOCATION[feature];
  if (!resolver) return false;
  return resolver(config);
}

/** Optional knobs for `tryLlmFeature`. */
export interface TryLlmFeatureOptions {
  /**
   * Hard timeout in milliseconds. Defaults to 600_000 (10 minutes) — generous
   * enough for any local model on a single-threaded server. Pass `0` or a
   * negative value to disable the wrapper-level timeout (the underlying `fn`
   * may still time out via its own transport timeout).
   */
  timeoutMs?: number;
  /**
   * Optional warning sink. Receives a structured `{ feature, reason, error }`
   * record on every fallback. Default: the wrapper is silent.
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

/**
 * Default hard timeout for every bounded in-tree LLM call.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Run `fn()` only if `isLlmFeatureEnabled(config, feature)` is `true`. On
 * disablement, throw, or timeout, return `fallback` (or — if it is a
 * thunk — the value produced by calling it).
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

/**
 * Section-agnostic process gate. After the 0.8.0 migration, the canonical
 * accessor is the `FEATURE_LOCATION` map above; this helper exists so older
 * call sites that knew the (section, processName) pair don't all need to
 * relearn the new mapping.
 *
 * For unknown (section, processName) pairs the result is `false`.
 */
export function isProcessEnabled(section: string, processName: string, config: AkmConfig | undefined): boolean {
  if (!config) return false;
  // index.metadataEnhance / index.stalenessDetection are first-class new-shape entries.
  if (section === "index") {
    if (processName === "metadata_enhance" || processName === "metadataEnhance") {
      return config.index?.metadataEnhance?.enabled ?? true;
    }
    if (processName === "staleness_detection" || processName === "stalenessDetection") {
      return config.index?.stalenessDetection?.enabled ?? false;
    }
    if (processName === "memory_inference" || processName === "memoryInference") {
      return isLlmFeatureEnabled(config, "memory_inference");
    }
    if (processName === "graph_extraction" || processName === "graphExtraction") {
      return isLlmFeatureEnabled(config, "graph_extraction");
    }
  }
  if (section === "search" && (processName === "curate_rerank" || processName === "curateRerank")) {
    return config.search?.curateRerank?.enabled ?? false;
  }
  if (section === "improve") {
    const processes = config.profiles?.improve?.default?.processes as
      | Record<string, { enabled?: boolean } | undefined>
      | undefined;
    const entry = processes?.[processName];
    if (entry && typeof entry.enabled === "boolean") return entry.enabled;
    // Fallback to default-enabled state for known processes.
    switch (processName) {
      case "reflect":
      case "distill":
      case "consolidate":
      case "memoryInference":
      case "graphExtraction":
        return true;
      default:
        return false;
    }
  }
  return false;
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
