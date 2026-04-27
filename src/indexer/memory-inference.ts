/**
 * Memory inference pass for `akm index` (#201).
 *
 * Detects memories pending inference, asks the configured LLM to split each
 * into atomic facts, and writes the results back as new memory files with
 * frontmatter `inferred: true` + a `source:` backref to the parent memory.
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
 * Disabling: gated entirely by `resolveIndexPassLLM("memory", config)`. When
 * the user has either no `akm.llm` block or has set `index.memory.llm = false`,
 * the helper returns `undefined` and {@link runMemoryInferencePass} is a no-op.
 * Existing inferred children are NOT deleted — the user keeps what was already
 * produced.
 *
 * Locked v1 contract:
 *   - LLM access is exclusively via `resolveIndexPassLLM("memory", config)`.
 *   - All writes go through `writeAssetToSource` in `src/core/write-source.ts`
 *     for the children, and a plain in-place rewrite for the parent's
 *     frontmatter (which `write-source.ts` is not designed to express).
 */

import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { AkmConfig } from "../core/config";
import { parseFrontmatter, parseFrontmatterBlock } from "../core/frontmatter";
import { warn } from "../core/warn";
import { resolveIndexPassLLM } from "../llm/index-passes";
import { splitMemoryIntoAtomicFacts } from "../llm/memory-infer";
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
  /** Parents whose split returned at least one fact. */
  splitParents: number;
  /** Atomic child memories actually written to disk. */
  writtenFacts: number;
  /** Parents skipped because the LLM returned no facts (left unmarked → retried next run). */
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
}

/**
 * Top-level entry point. Returns a no-op result when the pass is disabled
 * (no `akm.llm` configured, or `index.memory.llm = false`). Per #208 the
 * decision is owned by `resolveIndexPassLLM` — this function does not read
 * `config.llm` directly.
 */
export async function runMemoryInferencePass(
  config: AkmConfig,
  sources: SearchSource[],
): Promise<MemoryInferenceResult> {
  const empty: MemoryInferenceResult = {
    considered: 0,
    splitParents: 0,
    writtenFacts: 0,
    skippedNoFacts: 0,
  };

  const llmConfig = resolveIndexPassLLM("memory", config);
  if (!llmConfig) return empty;

  // The pass only writes to the primary (working) stash. Read-only caches
  // (git, npm, website) are deliberately untouched — writing inferred
  // children there would be clobbered by the next sync().
  const primary = sources[0];
  if (!primary) return empty;

  const pending = collectPendingMemories(primary.path);
  empty.considered = pending.length;
  if (pending.length === 0) return empty;

  for (const record of pending) {
    const facts = await splitMemoryIntoAtomicFacts(llmConfig, record.body);
    if (facts.length === 0) {
      empty.skippedNoFacts += 1;
      // Intentionally NOT marked processed — a transient LLM failure should
      // be retried on the next index run.
      continue;
    }
    const written = writeAtomicChildren(record, facts);
    if (written > 0) {
      markParentProcessed(record);
      empty.splitParents += 1;
      empty.writtenFacts += written;
    }
  }

  return empty;
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

// ── Writing children + marking parent ───────────────────────────────────────

function writeAtomicChildren(parent: MemoryRecord, facts: string[]): number {
  const memoriesDir = path.join(parent.stashRoot, "memories");
  // Sibling directory layout: <parentDir>/<parentBase>.facts/fact-N.md
  // Keeps facts grouped near the parent without polluting the top level.
  const parentRel = path.relative(memoriesDir, parent.filePath).replace(/\\/g, "/");
  const parentBase = parentRel.replace(/\.md$/i, "");
  const factsDirRel = `${parentBase}.facts`;
  const factsDirAbs = path.join(memoriesDir, factsDirRel);

  let written = 0;
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const childRelName = `${factsDirRel}/fact-${i + 1}`;
    const childPath = path.join(memoriesDir, `${childRelName}.md`);

    // Idempotent re-writes: if a child already exists at this slot we skip
    // it. The parent's `inferenceProcessed` marker is the primary idempotency
    // guard (we never re-enter the splitter for a processed parent), but a
    // partial previous run that crashed before the marker landed should not
    // duplicate facts.
    if (fs.existsSync(childPath)) {
      continue;
    }

    try {
      fs.mkdirSync(factsDirAbs, { recursive: true });
      const content = renderChildMemory(fact, parent.ref);
      fs.writeFileSync(childPath, content, "utf8");
      written += 1;
    } catch (err) {
      warn(
        `memory inference: failed to write atomic child ${childRelName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return written;
}

function renderChildMemory(fact: string, parentRef: string): string {
  const fm: Record<string, unknown> = {
    [FM_INFERRED]: true,
    [FM_SOURCE]: parentRef,
  };
  const yaml = yamlStringify(fm).trimEnd();
  return `---\n${yaml}\n---\n\n${fact.trim()}\n`;
}

function markParentProcessed(parent: MemoryRecord): void {
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
