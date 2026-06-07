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
 * Disabling — two orthogonal gates:
 *   1. `profiles.improve.default.processes.memoryInference.enabled = false`
 *      blocks the pass at the feature-flag layer (no network call may ever
 *      issue). Historically the v1 spec §14 gate, superseded by the 0.8.0
 *      profile shape.
 *   2. `index.memory.llm = false` (or no resolvable LLM profile) opts the
 *      pass out at the per-pass layer (#208).
 *   A pass runs iff both layers allow it. Existing inferred children are
 *   NEVER deleted — the user keeps what was already produced.
 *
 * Locked v1 contract:
 *   - LLM access is exclusively via `resolveIndexPassLLM("memory", config)`.
 *   - All child memory writes go through `writeAssetToSource` in
 *     `src/core/write-source.ts`. The parent's frontmatter rewrite is an
 *     explicit narrow exception — see {@link markParentProcessed}.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../../core/asset-ref";
import { assembleAsset } from "../../core/asset-serialize";
import { concurrentMap } from "../../core/concurrent";
import type { SourceConfigEntry } from "../../core/config";
import { parseFrontmatter, parseFrontmatterBlock } from "../../core/frontmatter";
import { warn } from "../../core/warn";
import { type WriteTargetSource, writeAssetToSource } from "../../core/write-source";
import { isProcessEnabled } from "../../llm/feature-gate";
import { resolveIndexPassLLM } from "../../llm/index-passes";
import type { DerivedMemoryDraft, MemoryInferTelemetry } from "../../llm/memory-infer";
import * as memoryInfer from "../../llm/memory-infer";
import { withLlmCache } from "../db/llm-cache";
import { walkMarkdownFiles } from "../walk/walker";
import type { EnrichmentPassContext } from "./pass-context";

/**
 * Frontmatter keys this pass cares about. Constants so a future rename only
 * needs to touch one site.
 */
const FM_INFERRED = "inferred";
const FM_INFERENCE_PROCESSED = "inferenceProcessed";
const FM_SOURCE = "source";
const FM_CAPTURE_MODE = "captureMode";

/** Telemetry returned to the caller. Useful for tests + future progress events. */
export interface MemoryInferenceResult {
  /** Number of pending parent memories considered (includes cache hits). */
  considered: number;
  /**
   * Parents whose body hash matched a prior LLM call's cached result. These
   * are no-op cache hits — no LLM call was made, no derived file was
   * (re-)written. Track separately from `considered` so the operational yield
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
  /** Parents skipped because the LLM returned no usable derived memory (left unmarked → retried next run). */
  skippedNoFacts: number;
  /**
   * Parents where the LLM returned a valid derived draft but the
   * `<parent>.derived.md` file already exists on disk (or the write threw).
   * The LLM attempt was consumed but no new fact was written — without this
   * counter the attempt would silently bleed into `freshAttempts` and drag
   * the health-reported yield rate below the operational truth.
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
}

export interface MemoryInferencePassOptions {
  candidateRefs?: ReadonlySet<string>;
}

/** Progress event emitted by {@link runMemoryInferencePass}. */
export interface MemoryInferenceProgress {
  processed: number;
  total: number;
  writtenFacts: number;
  skippedNoFacts: number;
  currentRef?: string;
}

/** Parameter object for {@link runMemoryInferencePass}. */
export type MemoryInferencePassContext = EnrichmentPassContext<MemoryInferenceProgress, MemoryInferencePassOptions>;

interface MemoryRecord {
  /** Absolute path on disk. */
  filePath: string;
  /** Source root the file lives under (the writable stash dir). */
  stashRoot: string;
  /** Parent ref name (`memory:<name>`) — used for the `source:` backref on children. */
  ref: string;
  /** Existing frontmatter (parsed). */
  data: Record<string, unknown>;
  /** Body text (everything after the frontmatter). */
  body: string;
  name: string;
}

/**
 * Top-level entry point. Returns a no-op result when the pass is disabled.
 *
 * Two orthogonal gates:
 *
 *   1. **Feature gate** — `profiles.improve.default.processes.memoryInference.enabled`
 *      (defaults to `true`). When `false`, no network call may issue regardless
 *      of per-pass settings.
 *   2. **Per-pass gate** — `resolveIndexPassLLM("memory", config)` (which
 *      reads `index.memory.llm`). When `false`, the indexer simply skips
 *      this pass for the current run.
 *
 * Both must allow the call for the pass to run. Either set to `false`
 * short-circuits to a no-op result.
 */
export async function runMemoryInferencePass(ctx: MemoryInferencePassContext): Promise<MemoryInferenceResult> {
  const { config, sources, signal, db, reEnrich, onProgress, options = {} } = ctx;
  const result: MemoryInferenceResult = {
    considered: 0,
    cacheHits: 0,
    retryAttempts: 0,
    splitParents: 0,
    writtenFacts: 0,
    skippedNoFacts: 0,
    skippedChildExists: 0,
    skippedAborted: 0,
    unaccounted: 0,
    htmlErrorCount: 0,
  };

  // Mutable sink threaded into compressMemoryToDerivedMemory so the per-call
  // HTML-error categorization (which is otherwise swallowed inside the feature
  // gate) bubbles up into the pass result.
  const inferTelemetry: MemoryInferTelemetry = {};

  // Gate 1 — feature gate via isProcessEnabled, which reads the 0.8.0 path
  // (profiles.improve.default.processes.memoryInference.enabled). Defaults to
  // enabled when the key is absent.
  if (!isProcessEnabled("index", "memory_inference", config)) return result;

  // Gate 2 — per-pass opt-out (#208). Returns the resolved llm config or
  // `undefined` when the pass should not run.
  const llmConfig = resolveIndexPassLLM("memory", config);
  if (!llmConfig) return result;

  // The pass only writes to the primary (working) stash. Read-only caches
  // (git, npm, website) are deliberately untouched — writing inferred
  // children there would be clobbered by the next sync().
  const primary = sources[0];
  if (!primary) return result;

  const pending = collectPendingMemories(primary.path).filter(
    (record) => !options.candidateRefs || options.candidateRefs.has(record.ref),
  );
  result.considered = pending.length;
  if (pending.length === 0) return result;

  let processed = 0;
  const total = pending.length;
  onProgress?.({ processed, total, writtenFacts: 0, skippedNoFacts: 0 });

  const perRecordResults = await concurrentMap(
    pending,
    async (record) => {
      // Aborted BEFORE a fresh LLM call. Returned as a typed outcome so the
      // for-loop below increments `skippedAborted` instead of silently
      // dropping the record (which historically inflated freshAttempts and
      // dragged the health-reported yield rate down — see investigation
      // 2026-05-26).
      if (signal?.aborted) return { aborted: true } as const;

      // Incremental cache: skip LLM call when body hash is unchanged and
      // --re-enrich was not requested. The cache ref is the absolute file path.
      const validate = (raw: unknown): DerivedMemoryDraft | undefined => {
        if (!raw || typeof raw !== "object") return undefined;
        const parsed = raw as Record<string, unknown>;
        const title = typeof parsed.title === "string" ? parsed.title : "";
        const description = typeof parsed.description === "string" ? parsed.description : "";
        const content = typeof parsed.content === "string" ? parsed.content : "";
        const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === "string") : [];
        const searchHints = Array.isArray(parsed.searchHints)
          ? parsed.searchHints.filter((h): h is string => typeof h === "string")
          : [];
        if (title && description && content && tags.length > 0 && searchHints.length > 0) {
          return { title, description, tags, searchHints, content };
        }
        return undefined;
      };

      // Track whether THIS candidate's result came from the body-hash
      // cache vs. a fresh LLM call. The cache short-circuits when the
      // parent body has not changed since a prior derived write — surfacing
      // the hit count separately so the operational yield rate
      // (writtenFacts / freshAttempts) is interpretable as the cache warms.
      let fromCache = false;
      // Count single bounded retries for transient LLM failures on this
      // candidate. Bumped via the `onRetryAttempt` callback threaded into
      // `chatCompletion`; surfaced as `retryAttempts` telemetry, never as a
      // failure for the same call.
      let retryAttempts = 0;
      const onRetryAttempt = () => {
        retryAttempts += 1;
      };
      const derived = db
        ? await withLlmCache<DerivedMemoryDraft>(
            db,
            record.filePath,
            record.body,
            reEnrich ?? false,
            () =>
              memoryInfer.compressMemoryToDerivedMemory(
                llmConfig,
                record.body,
                signal,
                config,
                (evt) => {
                  warn(`[akm] LLM fallback for ${evt.feature}: ${evt.reason}`);
                },
                inferTelemetry,
                onRetryAttempt,
              ),
            validate,
            undefined,
            "",
            {
              onCacheHit: () => {
                fromCache = true;
              },
            },
          )
        : await memoryInfer.compressMemoryToDerivedMemory(
            llmConfig,
            record.body,
            signal,
            config,
            (evt) => {
              warn(`[akm] LLM fallback for ${evt.feature}: ${evt.reason}`);
            },
            inferTelemetry,
            onRetryAttempt,
          );

      if (!derived) {
        return { skipped: true, fromCache, retryAttempts } as const;
      }
      const writeOutcome = await writeDerivedMemory(record, derived);
      if (writeOutcome.written > 0) {
        markParentProcessed(record);
        return { skipped: false, splitParent: true, written: writeOutcome.written, fromCache, retryAttempts } as const;
      }
      // LLM produced a valid derived draft but no file was written — either
      // because `<parent>.derived.md` already exists on disk or
      // `writeAssetToSource` threw. Categorise as `childExists` so the
      // attempt is accounted for in health metrics rather than vanishing
      // into the freshAttempts denominator.
      //
      // When the child already exists on disk the inference is, by definition,
      // already complete — so mark the parent processed here too (#550).
      // Without this, `isPendingMemory()` re-queues the same parent every run
      // (the `written > 0` path was previously the only site that marks it),
      // causing permanent re-queueing and wasted LLM calls. A genuine write
      // *failure* (`writeAssetToSource` threw) must NOT mark the parent — it
      // should be retried next run — so we key off the explicit `childExists`
      // outcome rather than the conflated `written === 0`.
      if (writeOutcome.childExists) {
        markParentProcessed(record);
      }
      return { skipped: false, splitParent: false, written: 0, fromCache, retryAttempts, childExists: true } as const;
    },
    // Default concurrency of 4 for cloud APIs. Set `llm.concurrency: 1`
    // in config.json for local model servers (LM Studio, Ollama).
    llmConfig.concurrency ?? 1,
  );

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
    } else if (res.splitParent) {
      result.splitParents += 1;
      result.writtenFacts += res.written;
    } else if ("childExists" in res && res.childExists) {
      // LLM call was consumed but the derived file already existed (or the
      // write threw). Track separately so this category is observable in
      // health output and stops bleeding into the freshAttempts denominator.
      result.skippedChildExists += 1;
      warn(
        `memory inference: derived child for ${pending[i]?.ref ?? "<unknown>"} already existed or write failed; counted as skippedChildExists`,
      );
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
      skippedNoFacts: result.skippedNoFacts,
      currentRef: pending[i]?.ref,
    });
  }

  result.htmlErrorCount = inferTelemetry.htmlErrorCount ?? 0;

  return result;
}

// ── Pending detection ───────────────────────────────────────────────────────

/**
 * Walk `<stashRoot>/memories/` (recursively) and return every memory that
 * still needs inference. The directory may not exist on a fresh stash; that
 * is treated as "no pending memories" rather than an error.
 */
export function collectPendingMemories(stashRoot: string): MemoryRecord[] {
  const memoriesDir = path.join(stashRoot, "memories");
  if (!fs.existsSync(memoriesDir)) return [];

  const out: MemoryRecord[] = [];
  for (const filePath of walkMarkdownFiles(memoriesDir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!isPendingMemory(parsed.data, filePath)) continue;

    const relName = toMemoryName(memoriesDir, filePath);
    if (!relName) continue;

    out.push({
      filePath,
      stashRoot,
      ref: `memory:${relName}`,
      data: parsed.data,
      body: parsed.content,
      name: relName,
    });
  }
  return out;
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

async function writeDerivedMemory(parent: MemoryRecord, derived: DerivedMemoryDraft): Promise<WriteDerivedOutcome> {
  const writeTarget: WriteTargetSource = {
    kind: "filesystem",
    name: "stash",
    path: parent.stashRoot,
  };
  const writeConfig: SourceConfigEntry = {
    type: "filesystem",
    name: "stash",
    path: parent.stashRoot,
    writable: true,
  };

  const childName = `${parent.name}.derived`;
  const childRefStr = `memory:${childName}`;
  const childPath = path.join(parent.stashRoot, "memories", `${childName}.md`);
  if (fs.existsSync(childPath)) {
    // The derived child is already on disk — inference for this parent is
    // complete. Report `childExists` so the caller marks the parent processed
    // (#550) instead of re-queueing it forever.
    return { written: 0, childExists: true };
  }

  try {
    const content = renderDerivedMemory(parent, derived);
    const childRef = parseAssetRef(childRefStr);
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
  const fm: Record<string, unknown> = {
    [FM_INFERRED]: true,
    [FM_CAPTURE_MODE]: "background",
    [FM_SOURCE]: parent.ref,
    description: derived.description,
    tags: derived.tags,
    searchHints: derived.searchHints,
    title: derived.title,
    derivedFrom: parent.name,
  };
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

  const updatedFm: Record<string, unknown> = { ...parent.data, [FM_INFERENCE_PROCESSED]: true };
  const block = parseFrontmatterBlock(raw);
  const body = block?.content ?? raw;
  const next = assembleAsset(updatedFm, body);
  try {
    fs.writeFileSync(parent.filePath, next, "utf8");
  } catch (err) {
    warn(
      `memory inference: failed to mark parent processed ${parent.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
