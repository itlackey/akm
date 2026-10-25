// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Memory inference pass for `akm index` (#201).
 *
 * Detects memories pending inference, asks the configured LLM to compress each
 * into one higher-signal derived memory, and writes the result back as a new
 * memory file with frontmatter `inferred: true` + a `source:` backref to the
 * parent memory.
 *
 * Pending predicate (see {@link isPendingMemory}):
 *   - File lives under `<stashRoot>/memories/` and ends in `.md`.
 *   - Frontmatter does NOT have `inferenceProcessed: true` (parent already split).
 *   - Frontmatter does NOT have `inferred: true` (this is itself a child fact).
 *
 * Idempotency: after a successful split the parent's frontmatter is rewritten
 * with `inferenceProcessed: true`. A subsequent `akm index` therefore skips
 * the parent without re-running the LLM.
 *
 * Disabling — one gate: `index.memory.enabled = false` (or no resolvable
 * connection or harness) leaves the pass with no runner, and no model call is
 * made (#208). Existing inferred children are NEVER deleted — the user keeps
 * what was already produced.
 *
 * Scope sync: on every run, an existing derived child (`<name>.derived.md`,
 * `inferred: true`, `derivedFrom` naming its parent) whose normalized scope
 * differs from its parent's gets only its scope frontmatter rewritten to the
 * parent's — deterministic, no model call, body and other metadata untouched.
 * See {@link syncDerivedChildScopes}.
 *
 * Locked v1 contract:
 *   - LLM access is exclusively via the frozen runner returned by
 *     `resolveIndexPassExecution("memory", config)`.
 *   - All child memory writes go through `writeAssetToSource` in
 *     `src/core/write-source.ts`. The parent's frontmatter rewrite is an
 *     explicit narrow exception — see {@link markParentProcessed}.
 */

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { assembleAsset, serializeFrontmatter } from "../../core/asset/asset-serialize";
import {
  parseFrontmatter,
  parseFrontmatterBlock,
  readFrontmatterDate,
  replaceFrontmatterBlocks,
} from "../../core/asset/frontmatter";
import { conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { bestEffort } from "../../core/best-effort";
import { asNonEmptyString, existingFileMode, writeFileAtomic } from "../../core/common";
import { concurrentMap } from "../../core/concurrent";
import type { SourceConfigEntry } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { warn } from "../../core/warn";
import { beginWriteProvenance, recordWrittenPath, type WriteProvenanceJournal } from "../../core/write-provenance";
import { type WriteTargetSource, writeAssetToSource } from "../../core/write-source";
import { type NoticeSink, noticeSet } from "../../execution/notices";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { type ResolvedIndexPassExecution, resolveIndexPassExecution } from "../../llm/index-passes";
import type { DerivedMemoryDraft, MemoryInferNoChange, MemoryInferTelemetry } from "../../llm/memory-infer";
import * as memoryInfer from "../../llm/memory-infer";
import { computeBodyHash, getLlmCacheEntry } from "../../storage/repositories/index-llm-cache-repository";
import { pkgVersion } from "../../version";
import { withLlmCache } from "../db/llm-cache";
import { walkMarkdownFiles } from "../walk/walker";
import {
  applyProvenanceFrontmatter,
  type IndexDocument,
  SCOPE_KEYS,
  type StashEntryScope,
  sameScope,
  scopeFromFrontmatter,
} from "./metadata";
import type { PassContext } from "./pass-context";

/**
 * Frontmatter keys this pass cares about. Constants so a future rename only
 * needs to touch one site.
 */
const FM_INFERRED = "inferred";
const FM_INFERENCE_PROCESSED = "inferenceProcessed";
const FM_SOURCE = "source";
const FM_CAPTURE_MODE = "captureMode";

/**
 * Cache namespace for this pass. Bump it when the cached response semantics
 * change (v4: body plus grounded source context; v5: `observed` in the
 * source context and prompt); rows under an
 * older namespace are never read again, which is a disposable cache miss.
 */
const MEMORY_INFERENCE_CACHE_VARIANT = "memory-inference-v5";

/** Telemetry returned to the caller. Useful for tests + future progress events. */
export interface MemoryInferenceResult {
  /** Number of pending parent memories considered (includes cache hits). */
  considered: number;
  /**
   * Parents whose effective input matched a prior LLM call's cached result (a
   * derived memory or a no-change decision). No LLM call was made. Track separately from `considered` so the operational yield
   * rate (`writtenFacts / freshAttempts`) doesn't drift as the cache warms.
   */
  cacheHits: number;
  /**
   * Count of single bounded retries triggered for transient LLM failures
   * during inference. Bumped only on the retry path — never together with a
   * failure for the same call.
   */
  retryAttempts: number;
  /** Parents whose inference returned a derived memory. */
  splitParents: number;
  /** Derived memory files actually written to disk. */
  writtenFacts: number;
  /**
   * Parents for which inference succeeded and decided no derived memory is
   * needed (a fresh decision or a cached one). Restraint, not failure: no child
   * is written, the parent is neither stamped nor modified, and the decision is
   * cached against the body and supplied source context, so the parent is considered again
   * after that input changes (or on a `reEnrich` run). Never counted in
   * `skippedNoFacts`, which stays the failure bucket.
   */
  noChange: number;
  /** Parents skipped because the LLM returned no usable derived memory (left unmarked → retried next run). */
  skippedNoFacts: number;
  /**
   * Parents whose `<parent>.derived.md` already exists on disk. The common
   * case (#588) is caught by a pre-check BEFORE any LLM/cache call — the
   * parent looked pending only because `markParentProcessed` never ran
   * (process killed between write and mark) or the child was created
   * externally; no LLM attempt is consumed and the parent is marked
   * processed on the spot. The rare residual case is a child appearing
   * mid-flight (or the write throwing) AFTER a fresh LLM call — tracked in
   * the same counter so the attempt does not silently bleed into
   * `freshAttempts` and drag the health-reported yield rate below the
   * operational truth.
   */
  skippedChildExists: number;
  /**
   * Parents short-circuited by an abort signal (Ctrl-C, budget timeout)
   * BEFORE a fresh LLM call was issued. Counted so `considered` decomposes
   * cleanly into accounted categories and aborts do not pollute yield.
   */
  skippedAborted: number;
  /**
   * Catch-all for any per-record result that did not fall into one of the
   * categorised buckets. Must stay zero in normal operation — a non-zero
   * value indicates a missing case in the per-record state machine.
   * Exposed (not asserted) so health can surface drift loudly.
   */
  unaccounted: number;
  /**
   * Parents whose LLM call returned an HTML body (e.g. LM Studio serving its
   * web UI) instead of JSON. Tracked distinctly from `skippedNoFacts` so a
   * provider-load failure is observable in health output rather than masked as
   * a generic empty-result skip.
   */
  htmlErrorCount: number;
  /**
   * Existing derived children whose scope frontmatter was rewritten to match
   * their parent's normalized scope (no model call; see
   * {@link syncDerivedChildScopes}). Counted apart from `considered`: the
   * parent may be long processed and is not a pending record.
   */
  scopeSynced: number;
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
  /**
   * Absolute paths this call actually wrote or rewrote — every derived child
   * (`writeAssetToSource`) and every parent whose frontmatter was stamped
   * `inferenceProcessed: true` (`markParentProcessed`), plus every child whose
   * scope was synced. Lets the caller index
   * exactly these files (`indexWrittenAssets`) instead of a full reindex
   * R78 — sourced from the run-scoped write-provenance journal
   * (`core/write-provenance.ts`), so it can never drift from what actually
   * hit disk.
   */
  writtenPaths: string[];
}

export interface MemoryInferencePassOptions {
  candidateRefs?: ReadonlySet<string>;
  compressMemoryToDerivedMemory?: typeof memoryInfer.compressMemoryToDerivedMemory;
}

/** Progress event emitted by {@link runMemoryInferencePass}. */
export interface MemoryInferenceProgress {
  processed: number;
  total: number;
  writtenFacts: number;
  noChange: number;
  skippedNoFacts: number;
  currentRef?: string;
}

/** Parameter object for {@link runMemoryInferencePass}. */
export interface MemoryInferencePassContext extends PassContext {
  /** When true, re-run enrichment even for entries with a valid cache hit. */
  reEnrich?: boolean;
  onProgress?: (event: MemoryInferenceProgress) => void;
  options?: MemoryInferencePassOptions;
  /** Preferred invocation-owned symbolic runner. Omit only for standalone index passes. */
  llmRunner?: RunnerSpec | null;
}

interface MemoryRecord {
  /** Absolute path on disk. */
  filePath: string;
  /** Source root the file lives under (the writable stash dir). */
  stashRoot: string;
  /** Parent conceptId used for candidate filtering and progress reporting. */
  ref: string;
  /** Existing frontmatter (parsed). */
  data: Record<string, unknown>;
  /** Canonical source input shared by request construction and both cache paths. */
  effectiveInput: string;
  name: string;
}

type MemoryInferencePlan =
  | { kind: "aborted"; record: MemoryRecord }
  | { kind: "existing-child"; record: MemoryRecord }
  | { kind: "cache-hit"; record: MemoryRecord; decision: MemoryInferDecision }
  | { kind: "model"; record: MemoryRecord };

type MemoryInferDecision = DerivedMemoryDraft | MemoryInferNoChange;

function validateDerivedMemoryDraft(raw: unknown): DerivedMemoryDraft | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const parsed = raw as Record<string, unknown>;
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const description = typeof parsed.description === "string" ? parsed.description : "";
  const content = typeof parsed.content === "string" ? parsed.content : "";
  const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const searchHints = Array.isArray(parsed.searchHints)
    ? parsed.searchHints.filter((hint): hint is string => typeof hint === "string")
    : [];
  return title && description && content && tags.length > 0 && searchHints.length > 0
    ? { title, description, tags, searchHints, content }
    : undefined;
}

/** Cache validator: a recognised no-change decision, a complete draft, or `undefined` (unusable → recompute). */
function validateMemoryInferDecision(raw: unknown): MemoryInferDecision | undefined {
  return memoryInfer.isMemoryInferNoChange(raw) ? memoryInfer.MEMORY_INFER_NO_CHANGE : validateDerivedMemoryDraft(raw);
}

function readCachedMemoryDecision(
  db: NonNullable<MemoryInferencePassContext["db"]>,
  record: MemoryRecord,
): MemoryInferDecision | undefined {
  return bestEffort(() => {
    const entry = getLlmCacheEntry(
      db,
      record.filePath,
      computeBodyHash(record.effectiveInput),
      MEMORY_INFERENCE_CACHE_VARIANT,
    );
    return entry ? validateMemoryInferDecision(JSON.parse(entry.resultJson)) : undefined;
  }, "memory inference cache read corrupt — fall through to recompute");
}

function planPendingMemoryRecord(
  record: MemoryRecord,
  ctx: Pick<MemoryInferencePassContext, "signal" | "db" | "reEnrich">,
): MemoryInferencePlan {
  if (ctx.signal?.aborted) return { kind: "aborted", record };
  if (fs.existsSync(derivedChildPath(record))) return { kind: "existing-child", record };
  if (ctx.db && !ctx.reEnrich) {
    const cached = readCachedMemoryDecision(ctx.db, record);
    if (cached) return { kind: "cache-hit", record, decision: cached };
  }
  return { kind: "model", record };
}

function memoryExecutionForContext(
  ctx: MemoryInferencePassContext,
  config: MemoryInferencePassContext["config"],
): ResolvedIndexPassExecution {
  if (Object.hasOwn(ctx, "llmRunner")) {
    return Object.freeze({ runner: ctx.llmRunner ?? undefined, notices: Object.freeze([]) });
  }
  return resolveIndexPassExecution("memory", config);
}

async function inferPendingMemoryRecord(
  plan: MemoryInferencePlan,
  ctx: {
    signal?: AbortSignal;
    db?: MemoryInferencePassContext["db"];
    reEnrich?: boolean;
    llmRunner: RunnerSpec;
    inferTelemetry: MemoryInferTelemetry;
    compressMemoryToDerivedMemory: typeof memoryInfer.compressMemoryToDerivedMemory;
    onNotices: NoticeSink;
    onConfigFailure: (error: ConfigError) => void;
  },
) {
  const { record } = plan;
  const { signal, db, reEnrich, llmRunner, inferTelemetry, compressMemoryToDerivedMemory, onNotices, onConfigFailure } =
    ctx;
  if (signal?.aborted || plan.kind === "aborted") return { aborted: true } as const;

  // Existing children are complete, but the parent may be unmarked after a
  // crash between the child write and parent update (or an external write).
  if (fs.existsSync(derivedChildPath(record))) {
    markParentProcessed(record);
    return {
      skipped: false,
      splitParent: false,
      written: 0,
      fromCache: false,
      retryAttempts: 0,
      childExists: true,
      precheck: true,
    } as const;
  }
  // The child can disappear after the read-only classification pass (for
  // example, an external cleanup racing this index run). The plan is not proof
  // that the child still exists at the mutation boundary: leave the parent
  // pending so a later run can classify and preflight the now-real model work.
  if (plan.kind === "existing-child") {
    return { skipped: true, fromCache: false, retryAttempts: 0 } as const;
  }

  let fromCache = plan.kind === "cache-hit";
  let retryAttempts = 0;
  const onRetryAttempt = () => {
    retryAttempts += 1;
  };
  const infer = () =>
    compressMemoryToDerivedMemory(llmRunner, record.effectiveInput, signal, inferTelemetry, onRetryAttempt, onNotices);
  let derived: MemoryInferDecision | undefined = plan.kind === "cache-hit" ? plan.decision : undefined;
  try {
    if (plan.kind === "model") {
      derived = db
        ? await withLlmCache<MemoryInferDecision>(
            db,
            record.filePath,
            record.effectiveInput,
            reEnrich ?? false,
            infer,
            validateMemoryInferDecision,
            undefined,
            MEMORY_INFERENCE_CACHE_VARIANT,
            {
              onCacheHit: () => {
                fromCache = true;
              },
            },
          )
        : await compressMemoryToDerivedMemory(
            llmRunner,
            record.effectiveInput,
            signal,
            inferTelemetry,
            onRetryAttempt,
            onNotices,
          );
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      onConfigFailure(error);
      return undefined;
    }
    throw error;
  }

  if (!derived) return { skipped: true, fromCache, retryAttempts } as const;
  // An explicit decision, not a failure. The parent is left exactly as it is: stamping it
  // `inferenceProcessed` would hide every later edit, and the cached decision already
  // stops the retry for as long as the effective input is unchanged.
  if (memoryInfer.isMemoryInferNoChange(derived)) {
    return { skipped: false, splitParent: false, written: 0, noChange: true, fromCache, retryAttempts } as const;
  }
  const writeOutcome = await writeDerivedMemory(record, derived);
  if (writeOutcome.written > 0) {
    markParentProcessed(record);
    return { skipped: false, splitParent: true, written: writeOutcome.written, fromCache, retryAttempts } as const;
  }
  // A child that appeared mid-flight is complete and can safely mark its
  // parent. A genuine write failure remains unmarked for a later retry.
  if (writeOutcome.childExists) markParentProcessed(record);
  return {
    skipped: false,
    splitParent: false,
    written: 0,
    fromCache,
    retryAttempts,
    childExists: true,
    precheck: false,
  } as const;
}

/**
 * Top-level entry point. Returns a no-op result when the pass is disabled.
 *
 * Two orthogonal gates:
 *
 *   1. **Feature gate** — the selected strategy's `processes.memoryInference.enabled`
 *      (defaults to `true`). When `false`, no network call may issue regardless
 *      of per-pass settings.
 *   2. **Per-pass gate** — `resolveIndexPassExecution("memory", config)` reads
 *      the index pass selection. Without a runner, the indexer simply skips
 *      this pass for the current run.
 *
 * Both must allow the call for the pass to run. Either set to `false`
 * short-circuits to a no-op result.
 */
export async function runMemoryInferencePass(ctx: MemoryInferencePassContext): Promise<MemoryInferenceResult> {
  // R78: owns the write-provenance journal end-to-end so it closes on every
  // exit path, including a throw out of the body below — an unclosed journal
  // would keep reporting every later write in this process as this call's own.
  const provenance = beginWriteProvenance();
  try {
    return await runMemoryInferencePassBody(ctx, provenance);
  } finally {
    provenance.end();
  }
}

async function runMemoryInferencePassBody(
  ctx: MemoryInferencePassContext,
  provenance: WriteProvenanceJournal,
): Promise<MemoryInferenceResult> {
  const { config, sources, signal, db, reEnrich, onProgress, options = {} } = ctx;
  const compressMemoryToDerivedMemory =
    options.compressMemoryToDerivedMemory ?? memoryInfer.compressMemoryToDerivedMemory;
  const result: MemoryInferenceResult = {
    considered: 0,
    cacheHits: 0,
    retryAttempts: 0,
    splitParents: 0,
    writtenFacts: 0,
    noChange: 0,
    skippedNoFacts: 0,
    skippedChildExists: 0,
    skippedAborted: 0,
    unaccounted: 0,
    htmlErrorCount: 0,
    scopeSynced: 0,
    writtenPaths: [],
  };

  // Mutable sink threaded into compressMemoryToDerivedMemory so the per-call
  // HTML-error categorization (which is otherwise logged and dropped as a
  // skipped memory) bubbles up into the pass result.
  const inferTelemetry: MemoryInferTelemetry = {};
  const notices = noticeSet();
  const completeResult = (): MemoryInferenceResult => {
    Object.assign(result, notices.fields());
    // Non-destructive read — the wrapper's `finally` owns closing the journal.
    result.writtenPaths = provenance.writtenPaths();
    return result;
  };

  // The one gate — per-pass opt-out (#208): no runner when `index.memory.enabled` is false or nothing is
  // configured. A caller that owns the runner has decided to run.
  const execution = memoryExecutionForContext(ctx, config);
  notices.add(execution.notices);
  const llmRunner = execution.runner;
  if (!llmRunner) return completeResult();

  // The pass only writes to the default (working) stash, found by its
  // `isDefault` flag and never by array position. Read-only caches (git, npm,
  // website) are deliberately untouched — writing inferred children there
  // would be clobbered by the next sync().
  const primary = sources.find((source) => source.isDefault === true);
  if (!primary) {
    warn("memory inference: skipped — no default bundle among the sources, so there is no write target");
    return completeResult();
  }
  if ((primary.adapterId ?? detectAdapterId(primary.path)) !== "akm") {
    warn(`memory inference: skipped — the default bundle at ${primary.path} is not an akm bundle`);
    return completeResult();
  }

  const inCandidates = (ref: string) => !options.candidateRefs || options.candidateRefs.has(ref);
  const scan = scanMemories(primary.path);
  // A read-only default bundle keeps its children as they are; the
  // deterministic scope rewrite runs before, and apart from, any model work.
  if (primary.writable !== false && !signal?.aborted) {
    result.scopeSynced = syncDerivedChildScopes(scan.scopeDrift.filter((drift) => inCandidates(drift.parentRef)));
  }
  const pending = scan.pending.filter((record) => inCandidates(record.ref));
  result.considered = pending.length;
  if (pending.length === 0) return completeResult();

  // Classify the whole batch without mutation.
  const plans = pending.map((record) => planPendingMemoryRecord(record, { signal, db, reEnrich }));

  let processed = 0;
  const total = pending.length;
  onProgress?.({ processed, total, writtenFacts: 0, noChange: 0, skippedNoFacts: 0 });

  let configFailure: ConfigError | undefined;
  const perRecordResults = await concurrentMap(
    plans,
    (plan) =>
      inferPendingMemoryRecord(plan, {
        signal,
        db,
        reEnrich,
        llmRunner,
        inferTelemetry,
        compressMemoryToDerivedMemory,
        onNotices: notices.add,
        onConfigFailure: (error) => {
          configFailure ??= error;
        },
      }),
    // The connection's own `concurrency` when it sets one, else 1.
    (llmRunner.kind === "connection" ? llmRunner.concurrency : undefined) ?? 1,
  );
  if (configFailure) throw configFailure;

  for (let i = 0; i < perRecordResults.length; i++) {
    const res = perRecordResults[i];
    if (!res) continue;
    if ("aborted" in res && res.aborted) {
      result.skippedAborted += 1;
      processed++;
      onProgress?.({
        processed,
        total,
        writtenFacts: result.writtenFacts,
        noChange: result.noChange,
        skippedNoFacts: result.skippedNoFacts,
        currentRef: pending[i]?.ref,
      });
      continue;
    }
    if (res.fromCache) {
      result.cacheHits += 1;
    }
    if ("retryAttempts" in res) {
      result.retryAttempts += res.retryAttempts;
    }
    if (res.skipped) {
      result.skippedNoFacts += 1;
      // Intentionally NOT marked processed — a transient LLM failure should
      // be retried on the next index run.
    } else if ("noChange" in res && res.noChange) {
      result.noChange += 1;
    } else if (res.splitParent) {
      result.splitParents += 1;
      result.writtenFacts += res.written;
    } else if ("childExists" in res && res.childExists) {
      // Derived child already on disk. Track separately so this category is
      // observable in health output and stops bleeding into the
      // freshAttempts denominator. Pre-check skips (#588) are the routine
      // self-healing path — no LLM attempt was consumed and the parent has
      // been marked processed — so only the rare post-LLM case (mid-flight
      // race or write failure) warrants a per-ref warning.
      result.skippedChildExists += 1;
      if (!res.precheck) {
        warn(
          `memory inference: derived child for ${pending[i]?.ref ?? "<unknown>"} already existed or write failed; counted as skippedChildExists`,
        );
      }
    } else {
      // The per-record state machine should cover every outcome. A hit here
      // means a new code path slipped past the categorisation — surface it
      // loudly so health metrics stay honest and we get a signal to fix.
      result.unaccounted += 1;
      warn(`memory inference: unaccounted per-record outcome for ${pending[i]?.ref ?? "<unknown>"}`);
    }
    processed++;
    onProgress?.({
      processed,
      total,
      writtenFacts: result.writtenFacts,
      noChange: result.noChange,
      skippedNoFacts: result.skippedNoFacts,
      currentRef: pending[i]?.ref,
    });
  }

  result.htmlErrorCount = inferTelemetry.htmlErrorCount ?? 0;
  return completeResult();
}

// ── Pending detection ───────────────────────────────────────────────────────

/**
 * Pending parents the `minPendingCount` gate should count: those with no cached
 * no-change decision for their current effective input. A decided parent stays unstamped
 * by design (so an edit re-opens it), but a pass made only of cached decisions
 * makes no model call. Read-only; `db` absent counts every pending parent.
 */
export function countPendingMemoriesNeedingDecision(
  stashRoot: string,
  db?: NonNullable<MemoryInferencePassContext["db"]>,
): number {
  const pending = collectPendingMemories(stashRoot);
  if (!db) return pending.length;
  return pending.filter((record) => readCachedMemoryDecision(db, record) !== memoryInfer.MEMORY_INFER_NO_CHANGE).length;
}

/**
 * Walk `<stashRoot>/memories/` (recursively) and return every memory that
 * still needs inference. The directory may not exist on a fresh stash; that
 * is treated as "no pending memories" rather than an error.
 */
export function collectPendingMemories(stashRoot: string): MemoryRecord[] {
  return scanMemories(stashRoot).pending;
}

/** An existing derived child whose scope differs from its parent's. */
interface ScopeDrift {
  childPath: string;
  /** Parent conceptId, for candidate filtering. */
  parentRef: string;
  /** Bare parent name the child's `derivedFrom` must keep naming. */
  parentName: string;
  /** The parent's normalized scope, the child's target. */
  scope: StashEntryScope;
}

/**
 * One walk of `<stashRoot>/memories/`: the pending parents, and the existing
 * derived children whose scope has drifted from their parent's.
 */
function scanMemories(stashRoot: string): { pending: MemoryRecord[]; scopeDrift: ScopeDrift[] } {
  const memoriesDir = path.join(stashRoot, "memories");
  if (!fs.existsSync(memoriesDir)) return { pending: [], scopeDrift: [] };

  const out: MemoryRecord[] = [];
  const parentScopes = new Map<string, StashEntryScope>();
  const children: { filePath: string; name: string; data: Record<string, unknown> }[] = [];
  const walked = walkMarkdownFiles(memoriesDir);
  if (!walked.complete) {
    warn(`memory inference: directory scan under ${memoriesDir} is incomplete — some memories may be missing`);
  }
  for (const filePath of walked.files) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      warn(
        `memory inference: failed to read candidate memory ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const parsed = parseFrontmatter(raw);
    const relName = toMemoryName(memoriesDir, filePath);
    if (!relName) continue;
    if (relName.endsWith(".derived")) {
      children.push({ filePath, name: relName, data: parsed.data });
      continue;
    }
    parentScopes.set(relName, scopeFromFrontmatter(parsed.data));
    if (!isPendingMemory(parsed.data, filePath)) continue;

    out.push({
      filePath,
      stashRoot,
      ref: conceptIdFromTypeName("memory", relName),
      data: parsed.data,
      effectiveInput: memoryInferenceInput(parsed.content, parsed.data),
      name: relName,
    });
  }
  const scopeDrift: ScopeDrift[] = [];
  for (const child of children) {
    const parentName = child.name.slice(0, -".derived".length);
    const scope = parentScopes.get(parentName);
    if (!scope || !isDerivedChildOf(child.data, parentName)) continue;
    if (sameScope(scopeFromFrontmatter(child.data), scope)) continue;
    scopeDrift.push({
      childPath: child.filePath,
      parentRef: conceptIdFromTypeName("memory", parentName),
      parentName,
      scope,
    });
  }
  return { pending: out, scopeDrift };
}

/** True only for a file this pass derived from `parentName`: `inferred: true` and a matching `derivedFrom`. */
function isDerivedChildOf(fm: Record<string, unknown>, parentName: string): boolean {
  if (fm[FM_INFERRED] !== true) return false;
  const derivedFrom = asNonEmptyString(fm.derivedFrom);
  return derivedFrom === parentName || derivedFrom === conceptIdFromTypeName("memory", parentName);
}

/**
 * Section markers of the effective input; `memory-infer-user.md` names them.
 * The context comes first and is pretty-printed JSON, whose lines are never
 * exactly `Body:`, so the first such line always starts the raw body.
 */
const SOURCE_CONTEXT_MARKER = "Source context:";
const BODY_MARKER = "Body:";

/** The non-empty strings of a frontmatter list; anything else is no list. */
function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map(asNonEmptyString).filter((value): value is string => value !== undefined) : [];
}

/**
 * The effective input: a fixed selection of existing source fields (never
 * arbitrary frontmatter or model-authored authority) as JSON, then the raw
 * trimmed body. One string drives the request and every cache lookup.
 */
function memoryInferenceInput(body: string, fm: Record<string, unknown>): string {
  const trimmedBody = body.trim();
  if (!trimmedBody) return "";
  const sourceContext: Record<string, unknown> = {};
  for (const key of ["title", "description", "evidence", "source", "observed", "created", "updated"]) {
    const value = key === "observed" ? readFrontmatterDate(fm, key) : asNonEmptyString(fm[key]);
    if (value) sourceContext[key] = value;
  }
  for (const key of ["evidenceSources", "xrefs", "sources"]) {
    const values = stringList(fm[key]);
    if (values.length) sourceContext[key] = values;
  }
  const entry: IndexDocument = { type: "memory", name: "source" };
  applyProvenanceFrontmatter(entry, fm);
  if (entry.provenance?.sources) sourceContext.provenance = { sources: entry.provenance.sources };
  sourceContext.scope = scopeFromFrontmatter(fm);
  return `${SOURCE_CONTEXT_MARKER}\n${JSON.stringify(sourceContext, null, 2)}\n\n${BODY_MARKER}\n${trimmedBody}`;
}

/**
 * Predicate: true when the parsed frontmatter indicates the memory has not
 * yet been split AND is not itself an inferred child.
 *
 * Also guards against `.derived` files whose `inferred:` frontmatter key has
 * been dropped by a manual edit or schema-repair rewrite. The file name suffix
 * is structural and immutable; frontmatter flags are mutable. A file whose
 * path contains `.derived` is always treated as a derived child regardless of
 * its frontmatter state — this prevents `<name>.derived.derived.md` chains.
 *
 * @param frontmatter - Parsed YAML frontmatter from the memory file.
 * @param filePath    - Optional absolute path to the memory file. When
 *                      supplied, the name-based guard is applied.
 *
 * Exported for direct unit testing — keeping the predicate in one place
 * avoids drift between the walker, tests, and any future consumers.
 */
export function isPendingMemory(frontmatter: Record<string, unknown>, filePath?: string): boolean {
  // Name-based guard: a `.derived` suffix in the path means this file is a
  // derived child regardless of what its frontmatter currently says.
  if (filePath !== undefined) {
    const base = path.basename(filePath, ".md");
    if (base.endsWith(".derived")) return false;
  }
  if (frontmatter[FM_INFERRED] === true) return false;
  if (frontmatter[FM_INFERENCE_PROCESSED] === true) return false;
  return true;
}

function toMemoryName(memoriesDir: string, filePath: string): string | undefined {
  const rel = path.relative(memoriesDir, filePath);
  if (!rel || rel.startsWith("..")) return undefined;
  // Strip the `.md` extension; preserve any nested subdirectory layout the
  // user has organised under memories/.
  return rel.replace(/\\/g, "/").replace(/\.md$/i, "");
}

// ── Writing derived memories + marking parent ───────────────────────────────

/**
 * Result of attempting to write a derived child for a parent memory.
 *
 * The two `written === 0` shapes are deliberately distinct so callers can mark
 * the parent processed only when the child already exists (inference complete)
 * and NOT when the write failed (transient — retry next run). See #550.
 */
interface WriteDerivedOutcome {
  /** 1 when a new derived file was written, 0 otherwise. */
  written: number;
  /** True when `<parent>.derived.md` already existed on disk (write skipped). */
  childExists: boolean;
}

/**
 * Absolute path of the derived child for a parent memory. Single source of
 * truth for the `<parent>.derived.md` naming convention — used both by the
 * pre-LLM existence check (#588) and the write path.
 */
function derivedChildPath(parent: MemoryRecord): string {
  return path.join(parent.stashRoot, "memories", `${parent.name}.derived.md`);
}

async function writeDerivedMemory(parent: MemoryRecord, derived: DerivedMemoryDraft): Promise<WriteDerivedOutcome> {
  const writeTarget: WriteTargetSource = {
    kind: "filesystem",
    name: "stash",
    path: parent.stashRoot,
    adapterId: "akm",
  };
  const writeConfig: SourceConfigEntry = {
    type: "filesystem",
    name: "stash",
    path: parent.stashRoot,
    writable: true,
  };

  const childName = `${parent.name}.derived`;
  const childRefStr = `memories/${childName}`;
  if (fs.existsSync(derivedChildPath(parent))) {
    // The derived child appeared on disk after the caller's pre-check (#588)
    // — a rare mid-flight race. Report `childExists` so the caller marks the
    // parent processed (#550) instead of re-queueing it forever.
    return { written: 0, childExists: true };
  }

  try {
    const content = renderDerivedMemory(parent, derived);
    const childRef = parseRefInput(childRefStr);
    await writeAssetToSource(writeTarget, writeConfig, childRef, content);
    return { written: 1, childExists: false };
  } catch (err) {
    warn(
      `memory inference: failed to write derived memory ${childName}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // A genuine write failure — the parent must remain pending so it is
    // retried on the next run. `childExists: false` keeps it from being
    // marked processed.
    return { written: 0, childExists: false };
  }
}

function renderDerivedMemory(parent: MemoryRecord, derived: DerivedMemoryDraft): string {
  // Generation is when and by what this file was written: deterministic, never
  // model-authored and never sent to the model. `updated` is that same instant
  // as the child's own modification date. Neither says when the facts were
  // observed or that they were verified, so no `verified` is stamped.
  const generatedAt = new Date().toISOString();
  const fm: Record<string, unknown> = {
    [FM_INFERRED]: true,
    [FM_CAPTURE_MODE]: "background",
    // The `source:` backref and internal candidate identity use the same current
    // `memories/<name>` conceptId spelling.
    [FM_SOURCE]: conceptIdFromTypeName("memory", parent.name),
    description: derived.description,
    tags: derived.tags,
    searchHints: derived.searchHints,
    title: derived.title,
    derivedFrom: parent.name,
    generated: { by: `akm/${pkgVersion}`, at: generatedAt },
    updated: generatedAt.slice(0, 10),
  };
  // The source's own explicit observation date and evidence are carried as
  // written. A missing one stays missing: `updated` and mtime are not dates of
  // the facts.
  const observed = readFrontmatterDate(parent.data, "observed");
  if (observed) fm.observed = observed;
  const evidence = asNonEmptyString(parent.data.evidence);
  if (evidence) fm.evidence = evidence;
  const evidenceSources = stringList(parent.data.evidenceSources);
  if (evidenceSources.length) fm.evidenceSources = evidenceSources;
  const sources: IndexDocument = { type: "memory", name: parent.name };
  applyProvenanceFrontmatter(sources, parent.data);
  if (sources.provenance?.sources) fm.provenance = { sources: sources.provenance.sources };
  for (const [key, value] of Object.entries(scopeFromFrontmatter(parent.data))) fm[`scope_${key}`] = value;
  return assembleAsset(fm, `# ${derived.title.trim()}\n\n${derived.content.trim()}\n`);
}

function markParentProcessed(parent: MemoryRecord): void {
  // Frontmatter-only rewrite of an existing asset: not a new asset write,
  // so writeAssetToSource isn't a fit here (it would round-trip the body
  // through the asset-spec rendering layer instead of preserving the
  // user's original markdown bytes verbatim). The narrow exception is
  // documented in v1 spec §10 step 5 and CLAUDE.md write-source rules.
  let raw: string;
  try {
    raw = fs.readFileSync(parent.filePath, "utf8");
  } catch (err) {
    warn(
      `memory inference: failed to re-read parent ${parent.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const block = parseFrontmatterBlock(raw);
  if (!block) {
    // Cannot safely rewrite malformed frontmatter — skip marking so the memory
    // is retried on the next run once the frontmatter is repaired. Writing with
    // `body = raw` would wrap the entire file (including the bad frontmatter)
    // in a new block, producing a duplicate-frontmatter corruption.
    warn(`memory inference: skipping markParentProcessed for ${parent.filePath} — could not parse frontmatter block`);
    return;
  }
  // Stamp the frontmatter as it is now: `parent.data` was parsed before the model
  // call, and writing it back would revert any edit made to the file since.
  const updatedFm: Record<string, unknown> = { ...parseFrontmatter(raw).data, [FM_INFERENCE_PROCESSED]: true };
  const next = assembleAsset(updatedFm, block.content);
  try {
    fs.writeFileSync(parent.filePath, next, "utf8");
    // #652: the parent's `inference_processed` stamp is a real asset mutation
    // (the documented writeAssetToSource exception above) — journal it.
    recordWrittenPath(parent.filePath);
  } catch (err) {
    warn(
      `memory inference: failed to mark parent processed ${parent.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Rewrite only the scope frontmatter of each drifted child to its parent's
 * normalized scope: the flat `scope_*` keys are set, stale ones and a legacy
 * nested `scope:` removed, and every other byte — body included — kept. No
 * model call. Each file is re-read and re-checked first, so a child edited
 * since the walk is judged as it is now; one that no longer drifts, is no
 * longer a derived child of that parent, or whose frontmatter cannot be edited
 * in place is left untouched. Like {@link markParentProcessed}, this is a
 * frontmatter-only exception to `writeAssetToSource`, written atomically and
 * journaled so the caller indexes and commits it. Returns the rewrite count.
 */
function syncDerivedChildScopes(drifts: readonly ScopeDrift[]): number {
  let synced = 0;
  const scopeKeys = ["scope", ...SCOPE_KEYS.map((key) => `scope_${key}`)];
  for (const drift of drifts) {
    try {
      const raw = fs.readFileSync(drift.childPath, "utf8");
      const data = parseFrontmatter(raw).data;
      if (!isDerivedChildOf(data, drift.parentName) || sameScope(scopeFromFrontmatter(data), drift.scope)) continue;
      const flat: Record<string, unknown> = {};
      for (const key of SCOPE_KEYS) if (drift.scope[key] !== undefined) flat[`scope_${key}`] = drift.scope[key];
      const lines = Object.keys(flat).length > 0 ? serializeFrontmatter(flat).split("\n") : [];
      const next = replaceFrontmatterBlocks(raw, scopeKeys, lines);
      const expected: Record<string, unknown> = { ...data };
      for (const key of scopeKeys) delete expected[key];
      Object.assign(expected, flat);
      if (next === null || !isDeepStrictEqual(parseFrontmatter(next).data, expected)) {
        warn(`memory inference: scope of ${drift.childPath} differs from its parent but cannot be rewritten in place`);
        continue;
      }
      writeFileAtomic(drift.childPath, next, existingFileMode(drift.childPath));
      recordWrittenPath(drift.childPath);
      synced += 1;
    } catch (err) {
      warn(
        `memory inference: failed to sync scope of ${drift.childPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return synced;
}
