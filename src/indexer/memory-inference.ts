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
 * Disabling — two orthogonal gates per v1 spec §14:
 *   1. `llm.features.memory_inference = false` blocks the pass at the
 *      locked feature-flag layer (no network call may ever issue).
 *   2. `index.memory.llm = false` (or no `akm.llm` block at all) opts the
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
import { stringify as yamlStringify } from "yaml";
import { parseAssetRef } from "../core/asset-ref";
import type { AkmConfig, SourceConfigEntry } from "../core/config";
import { parseFrontmatter, parseFrontmatterBlock } from "../core/frontmatter";
import { warn } from "../core/warn";
import { type WriteTargetSource, writeAssetToSource } from "../core/write-source";
import { resolveIndexPassLLM } from "../llm/index-passes";
import { compressMemoryToDerivedMemory, type DerivedMemoryDraft } from "../llm/memory-infer";
import type { SearchSource } from "./search-source";

/**
 * Frontmatter keys this pass cares about. Constants so a future rename only
 * needs to touch one site.
 */
const FM_INFERRED = "inferred";
const FM_INFERENCE_PROCESSED = "inferenceProcessed";
const FM_SOURCE = "source";

/** Telemetry returned to the caller. Useful for tests + future progress events. */
export interface MemoryInferenceResult {
  /** Number of pending parent memories considered. */
  considered: number;
  /** Parents whose inference returned a derived memory. */
  splitParents: number;
  /** Derived memory files actually written to disk. */
  writtenFacts: number;
  /** Parents skipped because the LLM returned no usable derived memory (left unmarked → retried next run). */
  skippedNoFacts: number;
}

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
 * Two orthogonal gates per v1 spec §14:
 *
 *   1. **Feature gate** — `llm.features.memory_inference` (defaults to
 *      `true`). When `false`, no network call may issue regardless of
 *      per-pass settings. This is the locked spec-§14 gate.
 *   2. **Per-pass gate** — `resolveIndexPassLLM("memory", config)` (which
 *      reads `index.memory.llm`). When `false`, the indexer simply skips
 *      this pass for the current run.
 *
 * Both must allow the call for the pass to run. Either set to `false`
 * short-circuits to a no-op result.
 */
export async function runMemoryInferencePass(
  config: AkmConfig,
  sources: SearchSource[],
  signal?: AbortSignal,
): Promise<MemoryInferenceResult> {
  const result: MemoryInferenceResult = {
    considered: 0,
    splitParents: 0,
    writtenFacts: 0,
    skippedNoFacts: 0,
  };

  // Gate 1 — locked feature flag (§14). Defaults to enabled; only an
  // explicit `false` disables the pass entirely.
  if (config.llm?.features?.memory_inference === false) return result;

  // Gate 2 — per-pass opt-out (#208). Returns the resolved llm config or
  // `undefined` when the pass should not run.
  const llmConfig = resolveIndexPassLLM("memory", config);
  if (!llmConfig) return result;

  // The pass only writes to the primary (working) stash. Read-only caches
  // (git, npm, website) are deliberately untouched — writing inferred
  // children there would be clobbered by the next sync().
  const primary = sources[0];
  if (!primary) return result;

  const pending = collectPendingMemories(primary.path);
  result.considered = pending.length;
  if (pending.length === 0) return result;

  for (const record of pending) {
    if (signal?.aborted) return result;
    const derived = await compressMemoryToDerivedMemory(llmConfig, record.body, signal);
    if (!derived) {
      result.skippedNoFacts += 1;
      // Intentionally NOT marked processed — a transient LLM failure should
      // be retried on the next index run.
      continue;
    }
    const written = await writeDerivedMemory(record, derived);
    if (written > 0) {
      markParentProcessed(record);
      result.splitParents += 1;
      result.writtenFacts += written;
    }
  }

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
    if (!isPendingMemory(parsed.data)) continue;

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
 * Exported for direct unit testing — keeping the predicate in one place
 * avoids drift between the walker, tests, and any future consumers.
 */
export function isPendingMemory(frontmatter: Record<string, unknown>): boolean {
  if (frontmatter[FM_INFERRED] === true) return false;
  if (frontmatter[FM_INFERENCE_PROCESSED] === true) return false;
  return true;
}

function* walkMarkdownFiles(root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      yield full;
    }
  }
}

function toMemoryName(memoriesDir: string, filePath: string): string | undefined {
  const rel = path.relative(memoriesDir, filePath);
  if (!rel || rel.startsWith("..")) return undefined;
  // Strip the `.md` extension; preserve any nested subdirectory layout the
  // user has organised under memories/.
  return rel.replace(/\\/g, "/").replace(/\.md$/i, "");
}

// ── Writing derived memories + marking parent ───────────────────────────────

async function writeDerivedMemory(parent: MemoryRecord, derived: DerivedMemoryDraft): Promise<number> {
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
    return 0;
  }

  try {
    const content = renderDerivedMemory(parent, derived);
    const childRef = parseAssetRef(childRefStr);
    await writeAssetToSource(writeTarget, writeConfig, childRef, content);
    return 1;
  } catch (err) {
    warn(
      `memory inference: failed to write derived memory ${childName}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

function renderDerivedMemory(parent: MemoryRecord, derived: DerivedMemoryDraft): string {
  const fm: Record<string, unknown> = {
    [FM_INFERRED]: true,
    [FM_SOURCE]: parent.ref,
    description: derived.description,
    tags: derived.tags,
    searchHints: derived.searchHints,
    title: derived.title,
    derivedFrom: parent.name,
  };
  const yaml = yamlStringify(fm).trimEnd();
  return `---\n${yaml}\n---\n\n# ${derived.title.trim()}\n\n${derived.content.trim()}\n`;
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
  const yaml = yamlStringify(updatedFm).trimEnd();
  const block = parseFrontmatterBlock(raw);
  const body = block?.content ?? raw;
  const next = `---\n${yaml}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`;
  try {
    fs.writeFileSync(parent.filePath, next, "utf8");
  } catch (err) {
    warn(
      `memory inference: failed to mark parent processed ${parent.filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
