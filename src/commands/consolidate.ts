// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir, timestampForFilename } from "../core/common";
import type { AkmConfig } from "../core/config";
import { getDefaultLlmConfig, loadConfig } from "../core/config";
import { ConfigError } from "../core/errors";
import { appendEvent } from "../core/events";
import { parseFrontmatter } from "../core/frontmatter";
import { writeContradictEdge } from "../core/memory-belief";
import { parseEmbeddedJsonResponse } from "../core/parse";
import {
  hasHotCaptureMode,
  hasSupersededStatus,
  validateProposalFrontmatter,
} from "../core/proposal-quality-validators";
import { createProposal, isProposalSkipped, listProposals } from "../core/proposals";
import { detectTruncatedDescription } from "../core/text-truncation";

// Re-export the moved helpers so existing test imports continue to resolve.
export { hasSupersededStatus, validateProposalFrontmatter };

import { warn } from "../core/warn";
import { deleteAssetFromSource, resolveWriteTarget, writeAssetToSource } from "../core/write-source";
import type { DbIndexedEntry } from "../indexer/db";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../indexer/db";
import { chatCompletion } from "../llm/client";
import { cosineSimilarity, embedBatch } from "../llm/embedder";
import { isLlmFeatureEnabled, tryLlmFeature } from "../llm/feature-gate";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ConsolidateMergeOp {
  op: "merge";
  primary: string;
  secondaries: string[];
  mergeStrategy: string;
}

export interface ConsolidateDeleteOp {
  op: "delete";
  ref: string;
  reason: string;
}

export interface ConsolidatePromoteOp {
  op: "promote";
  ref: string;
  knowledgeRef: string;
  reason: string;
  /** One-sentence description for the new knowledge asset's frontmatter. */
  description?: string;
}

/**
 * Contradict op (C-3 / #382): two memories make mutually exclusive factual
 * claims. The consolidate engine writes `contradictedBy` frontmatter edges
 * so `resolveFamilyContradictions` in `memory-improve.ts` can resolve them
 * via its SCC algorithm. Zep arXiv:2501.13956 §3.
 */
export interface ConsolidateContradictOp {
  op: "contradict";
  /** The memory that should be marked as contradicted. */
  ref: string;
  /** The memory that contradicts it. */
  contradictedByRef: string;
  reason: string;
}

export type ConsolidateOperation =
  | ConsolidateMergeOp
  | ConsolidateDeleteOp
  | ConsolidatePromoteOp
  | ConsolidateContradictOp;

export interface ConsolidateResult {
  schemaVersion: 1;
  ok: boolean;
  shape: "consolidate-result";
  dryRun: boolean;
  previewOnly: boolean;
  target: string;
  processed: number;
  merged: number;
  deleted: number;
  promoted: string[];
  /** Number of contradiction edges written (C-3 / #382). */
  contradicted: number;
  planned?: ConsolidateOperation[];
  warnings: string[];
  durationMs: number;
}

export interface AkmConsolidateOptions {
  target?: string; // which source to target; defaults to primary writable stash
  dryRun?: boolean; // generate AI plan but skip all writes
  /**
   * Confidence threshold (0-100). Undefined disables auto-accept and enables
   * interactive confirmation on the HTTP consolidation path.
   */
  autoAccept?: number;
  task?: string; // extra guidance appended to the system prompt
  stashDir?: string;
  config?: AkmConfig;
  /** When true, indicates the run was triggered automatically by volume threshold rather than by the memory_consolidation feature flag. */
  autoTriggered?: boolean;
  /** How to handle stale/incomplete consolidate journals from prior interrupted runs. */
  recoveryMode?: "abort" | "clean";
}

// ── Prompts ─────────────────────────────────────────────────────────────────

const CONSOLIDATE_SYSTEM_PROMPT = `You are the akm consolidate assistant analyzing memory assets.

Rules:
1. MERGE: Two or more memories are substantially duplicated or closely related → propose merging. Return the primary ref to keep and secondary refs to delete. Do NOT include mergedContent — the merge will be executed in a separate step.
2. DELETE: Memory is clearly outdated, contradicted, or redundant → propose deletion.
3. PROMOTE: Memory expresses a stable, reusable fact suitable as a \`knowledge:\` asset → propose promotion. Do NOT delete the source memory.
4. CONTRADICT: Two memories make mutually exclusive factual claims about the same subject (e.g. "always use VPN" vs "VPN is optional") → mark the older or less authoritative one as contradicted. This writes a contradictedBy edge so the belief-resolution SCC algorithm can resolve the conflict. Do NOT delete contradicted memories — let the belief resolver decide.
5. KEEP: Memory is unique and current → omit from output.

Return ONLY JSON (no prose, no code fences):
{
  "operations": [
    { "op": "merge", "primary": "memory:<name>", "secondaries": ["memory:<name>", ...], "mergeStrategy": "synthesize" },
    { "op": "delete", "ref": "memory:<name>", "reason": "<brief reason>" },
    { "op": "promote", "ref": "memory:<name>", "knowledgeRef": "knowledge:<suggested-slug>", "reason": "<brief reason>", "description": "<one sentence describing the new knowledge asset>" },
    { "op": "contradict", "ref": "memory:<name>", "contradictedByRef": "memory:<name>", "reason": "<brief reason>" }
  ],
  "warnings": ["<optional concerns>"]
}

When the merged content includes an \`updated\` frontmatter field, the value MUST be a real ISO date string (e.g. \`updated: 2026-05-20\`). NEVER emit \`updated: today\`, \`updated: {today}\`, \`updated: {today: null}\`, \`updated: now\`, or any other literal placeholder/template-variable. If you do not have a real source-of-truth date, OMIT the \`updated\` field entirely — the post-processor will not invent one for you.`;

/**
 * JSON Schema for structured consolidate plans (PR 1 of the asset-writers
 * decision — see knowledge:projects/akm/asset-writers-investigation/00-synthesis).
 * Mirrors the {ops[], warnings?[]} shape currently described in
 * CONSOLIDATE_SYSTEM_PROMPT. Providers with `supportsJsonSchema: true` enforce
 * the shape upstream so the chunk-level "invalid plan from AI — skipping"
 * branch in `runConsolidate` becomes unreachable on schema-honouring providers.
 *
 * The four operation variants (merge / delete / promote / contradict) are
 * modeled as a oneOf so a structured-output provider can still tell them apart
 * by the required `op` discriminator. `parseEmbeddedJsonResponse` keeps
 * working as a fallback parser for providers that ignore the schema.
 */
export const CONSOLIDATE_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["operations"],
  additionalProperties: false,
  properties: {
    operations: {
      type: "array",
      description: "Ordered list of consolidate operations the planner proposes.",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["op", "primary", "secondaries", "mergeStrategy"],
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["merge"] },
              primary: { type: "string", minLength: 1 },
              secondaries: {
                type: "array",
                minItems: 1,
                items: { type: "string", minLength: 1 },
              },
              mergeStrategy: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            required: ["op", "ref", "reason"],
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["delete"] },
              ref: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            required: ["op", "ref", "knowledgeRef", "reason"],
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["promote"] },
              ref: { type: "string", minLength: 1 },
              knowledgeRef: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
              description: { type: "string" },
            },
          },
          {
            type: "object",
            required: ["op", "ref", "contradictedByRef", "reason"],
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["contradict"] },
              ref: { type: "string", minLength: 1 },
              contradictedByRef: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 },
            },
          },
        ],
      },
    },
    warnings: {
      type: "array",
      description: "Optional list of human-readable concerns the planner wants to surface.",
      items: { type: "string" },
    },
  },
};

// ── Memory loading ───────────────────────────────────────────────────────────

export interface MemoryEntry {
  name: string;
  filePath: string;
  description: string;
  tags: string[];
  stashDir: string;
}

export function isConsolidationEligibleMemoryName(name: string): boolean {
  return !name.endsWith(".derived");
}

/**
 * Returns true when the memory file has `captureMode: hot` in its frontmatter.
 *
 * Hot memories are USER-EXPLICIT (written via `akm remember` on the hot path).
 * The consolidate LLM is forbidden from deleting or auto-merging them — the
 * user wrote them on purpose and only the user can decide to retire them.
 *
 * Reads the file once per check; consolidate runs against ~10 memories per
 * chunk so the IO cost is trivial. Returns false on any read/parse error
 * (fail-safe: an unparseable file is treated as not-hot, but the broader
 * consolidate flow already guards against unparseable memories elsewhere).
 *
 * Defends against four observed defect classes (see
 * `memory:akm-improve-critical-review-2026-05-20`):
 *   - LLM marks a memory contradicted then deletes (dangling contradictedBy)
 *   - LLM merges two unrelated memories sharing a topic keyword
 *   - LLM judges a recent durable design memo as "redundant"
 *   - Cascade deletes (LLM uses ref:X as `contradictedBy` for ref:Y then deletes both)
 */
export function isHotCapturedMemory(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    return hasHotCaptureMode(parsed.data as Record<string, unknown> | undefined);
  } catch {
    return false;
  }
}

// ── Chunk sizing ─────────────────────────────────────────────────────────────

/**
 * Conservative chars-per-token estimate used when computing prompt budgets.
 * English text averages roughly 4 chars/token for most LLM tokenizers. We use
 * 3 to stay conservative (shorter tokens = more tokens per char).
 */
const CHARS_PER_TOKEN = 3;

/**
 * Overhead budget reserved for the system prompt, chunk header lines, and per-
 * memory metadata lines (name, description, tags, separator). Measured at
 * roughly 600 chars for the system prompt + ~100 chars of header + ~50 chars
 * per memory × chunk size.  We round up to 2 000 tokens to leave room for the
 * model's own output.
 */
const PROMPT_OVERHEAD_TOKENS = 2_000;

/**
 * Default effective token budget used when the default LLM profile's
 * `contextLength` is not set. This is intentionally conservative (4 096)
 * rather than being set to the model's actual context window, because:
 *
 *   - When the agent path is used, the agent CLI (e.g. opencode)
 *     prepends its own large system prompt + conversation history before
 *     forwarding to the model. That overhead easily consumes 30K+ tokens on
 *     a model with a 16K context window, leaving very little room for
 *     chunk content.
 *   - When the HTTP path is used (an LLM profile is selected), only the akm
 *     system prompt and user prompt are sent, so the budget can be set to the
 *     model's actual context length via profiles.llm[defaults.llm].contextLength.
 *
 * Set profiles.llm[defaults.llm].contextLength in your config file to the
 * model's actual context window to allow larger chunks on the HTTP path.
 */
export const DEFAULT_CONTEXT_LENGTH_TOKENS = 4_096;

/**
 * Given the model's context window and the per-memory body truncation limit,
 * return the maximum number of memories that can safely fit in one chunk
 * without the prompt overflowing the context window.
 *
 * The formula is:
 *   usableTokens = contextLength - PROMPT_OVERHEAD_TOKENS
 *   tokensPerMemory = ceil(bodyTruncation / CHARS_PER_TOKEN)
 *   chunkSize = floor(usableTokens / tokensPerMemory)
 *
 * Result is clamped between 1 and 50 to avoid degenerate values.
 *
 * @param contextLength - Model context window in tokens.
 * @param bodyTruncation - Max chars per memory body included in the prompt.
 */
export function computeSafeChunkSize(contextLength: number, bodyTruncation: number): number {
  const usableTokens = Math.max(contextLength - PROMPT_OVERHEAD_TOKENS, 0);
  const tokensPerMemory = Math.max(Math.ceil(bodyTruncation / CHARS_PER_TOKEN), 1);
  const raw = Math.floor(usableTokens / tokensPerMemory);
  return Math.max(1, Math.min(50, raw));
}

// ── Similarity clustering (C-1 / #380) ──────────────────────────────────────

/**
 * Re-order memories so that similar ones are placed adjacent to each other
 * before the memories are sliced into chunks. This ensures high-similarity
 * memories land in the same LLM context window, allowing the consolidate
 * model to detect and merge duplicates that would otherwise be split across
 * chunks and survive indefinitely.
 *
 * Algorithm: greedy nearest-neighbour chain starting from the first memory.
 * Each step selects the unused memory with the highest cosine similarity to
 * the last-placed memory. O(n²) — acceptable for the expected N < 200.
 *
 * mem0 arXiv:2504.19413 — every candidate compared against whole store.
 * A-MEM arXiv:2502.12110 — atomic notes linked by similarity.
 *
 * Returns the original order unchanged when:
 *   - The embedding config is not present.
 *   - Embedding requests fail (fail-open).
 *   - There are fewer than 3 memories (no benefit to reordering).
 */
async function clusterMemoriesBySimilarity(memories: MemoryEntry[], config: AkmConfig): Promise<MemoryEntry[]> {
  if (memories.length < 3 || !config.embedding) return memories;

  const texts = memories.map((m) => {
    const parts: string[] = [];
    if (m.description) parts.push(m.description);
    if (m.tags.length > 0) parts.push(m.tags.join(" "));
    return parts.join(". ") || m.name;
  });

  let embeddings: number[][] | null = null;
  try {
    embeddings = await embedBatch(texts, config.embedding);
  } catch {
    // Fail open: embedding failures degrade gracefully to original order.
    return memories;
  }
  if (!embeddings || embeddings.length !== memories.length) return memories;

  // Greedy nearest-neighbour chain.
  const used = new Array<boolean>(memories.length).fill(false);
  const ordered: MemoryEntry[] = [];
  let current = 0; // start from the first memory

  ordered.push(memories[current] as MemoryEntry);
  used[current] = true;

  for (let step = 1; step < memories.length; step++) {
    const currentEmb = embeddings[current] as number[];
    let bestIdx = -1;
    let bestSim = -Infinity;
    for (let j = 0; j < memories.length; j++) {
      if (used[j]) continue;
      const sim = cosineSimilarity(currentEmb, embeddings[j] as number[]);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = j;
      }
    }
    if (bestIdx === -1) break;
    ordered.push(memories[bestIdx] as MemoryEntry);
    used[bestIdx] = true;
    current = bestIdx;
  }

  return ordered;
}

// ── Chunk helpers ────────────────────────────────────────────────────────────

export function buildChunkPrompt(
  sourceName: string,
  memories: MemoryEntry[],
  chunkIndex: number,
  totalChunks: number,
  bodyTruncation: number,
): string {
  const start = memories[0] ? `memory:${memories[0].name}` : "";
  const end = memories[memories.length - 1] ? `memory:${memories[memories.length - 1].name}` : "";
  const lines: string[] = [
    `Source: ${sourceName}`,
    `Chunk ${chunkIndex + 1} of ${totalChunks}, memories ${start}–${end}:`,
    "",
  ];
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    lines.push(`[${i + 1}] memory:${m.name}`);
    lines.push(`Description: ${m.description || "(none)"}`);
    lines.push(`Tags: ${m.tags.length > 0 ? m.tags.join(", ") : "(none)"}`);
    lines.push("---");
    let body = "";
    try {
      body = fs.readFileSync(m.filePath, "utf8");
    } catch {
      body = "(unreadable)";
    }
    lines.push(body.slice(0, bodyTruncation));
    lines.push("");
  }
  return lines.join("\n");
}

// ── Plan parsing / merging ───────────────────────────────────────────────────

interface RawChunkPlan {
  operations?: unknown[];
  warnings?: unknown[];
}

function isValidOp(op: unknown): op is ConsolidateOperation {
  if (typeof op !== "object" || op === null) return false;
  const o = op as Record<string, unknown>;
  if (o.op === "merge") {
    return typeof o.primary === "string" && Array.isArray(o.secondaries);
  }
  if (o.op === "delete") {
    return typeof o.ref === "string";
  }
  if (o.op === "promote") {
    return typeof o.ref === "string" && typeof o.knowledgeRef === "string";
  }
  if (o.op === "contradict") {
    return typeof o.ref === "string" && typeof o.contradictedByRef === "string";
  }
  return false;
}

export function mergePlans(chunks: ConsolidateOperation[][]): { ops: ConsolidateOperation[]; warnings: string[] } {
  const mergeOps = new Map<string, ConsolidateMergeOp>();
  const deleteOps = new Map<string, ConsolidateDeleteOp>();
  const promoteOps = new Map<string, ConsolidatePromoteOp>();
  // C-3 / #382: contradict ops keyed by `ref|contradictedByRef` to deduplicate.
  const contradictOps = new Map<string, ConsolidateContradictOp>();
  const warnings: string[] = [];

  for (const chunk of chunks) {
    for (const op of chunk) {
      if (op.op === "merge") {
        // merge wins over delete
        if (deleteOps.has(op.primary)) {
          deleteOps.delete(op.primary);
        }
        for (const sec of op.secondaries) {
          if (deleteOps.has(sec)) deleteOps.delete(sec);
        }
        mergeOps.set(op.primary, op);
      } else if (op.op === "delete") {
        if (!mergeOps.has(op.ref)) {
          deleteOps.set(op.ref, op);
        }
      } else if (op.op === "promote") {
        // C-2 / #381: when both a promote and a merge target the same ref,
        // queue the promote FIRST rather than discarding it. The promote op
        // routes through createProposal (the human-gated proposal queue), so
        // it is non-destructive. The merge follows after the proposal is
        // created. This preserves the human reviewer's ability to inspect the
        // promotion before the source memory is merged/deleted.
        // AGM K*8 — retain the maximally informative consistent subset.
        promoteOps.set(op.ref, op);
      } else if (op.op === "contradict") {
        // Deduplicate by ref+contradictedByRef pair.
        const key = `${op.ref}|${op.contradictedByRef}`;
        if (!contradictOps.has(key)) {
          contradictOps.set(key, op);
        }
      }
    }
  }

  // C-2 / #381: promote ops are ordered BEFORE merge ops so that the
  // human-gated proposal queue entry is created before any destructive merge.
  // Phase B processes ops in array order, so promote executes first.
  const ops: ConsolidateOperation[] = [
    ...promoteOps.values(),
    ...mergeOps.values(),
    ...deleteOps.values(),
    ...contradictOps.values(),
  ];
  return { ops, warnings };
}

// ── Journal helpers ──────────────────────────────────────────────────────────

interface ConsolidateJournal {
  startedAt: string;
  operations: ConsolidateOperation[];
  completed: string[];
  backupTimestamp?: string;
}

function getJournalPath(stashDir: string): string {
  return path.join(stashDir, ".akm", "consolidate-journal.json");
}

function getBackupDir(stashDir: string, timestamp: string): string {
  return path.join(stashDir, ".akm", "consolidate-backup", timestamp);
}

function removeStaleJournal(stashDir: string, journal: ConsolidateJournal, warnings: string[]): void {
  const journalPath = getJournalPath(stashDir);
  try {
    fs.unlinkSync(journalPath);
  } catch {
    warnings.push(`Failed to remove stale consolidate journal at ${journalPath}.`);
  }

  const backupTimestamp =
    typeof journal.backupTimestamp === "string" && journal.backupTimestamp.trim().length > 0
      ? journal.backupTimestamp.trim()
      : typeof journal.startedAt === "string" && journal.startedAt.trim().length > 0
        ? journal.startedAt.replace(/[:.]/g, "-")
        : "";
  if (!backupTimestamp) return;

  const backupDir = getBackupDir(stashDir, backupTimestamp);
  if (!fs.existsSync(backupDir)) return;
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch {
    warnings.push(`Failed to remove stale consolidate backup at ${backupDir}.`);
  }

  warnings.push(`Cleared stale consolidate backup at ${backupDir}.`);
}

function checkForIncompleteJournal(stashDir: string, recoveryMode: "abort" | "clean", warnings: string[]): void {
  const journalPath = getJournalPath(stashDir);
  if (!fs.existsSync(journalPath)) return;

  let journal: ConsolidateJournal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as ConsolidateJournal;
  } catch {
    if (recoveryMode === "clean") {
      try {
        fs.unlinkSync(journalPath);
        warnings.push(`Removed unreadable consolidate journal at ${journalPath}.`);
      } catch {
        warnings.push(`Failed to remove unreadable consolidate journal at ${journalPath}.`);
      }
      return;
    }
    throw new ConfigError(
      `Incomplete consolidation state detected: unreadable journal at ${journalPath}. Re-run with --consolidate-recovery clean to remove stale journal artifacts, or remove the file manually.`,
      "INVALID_CONFIG_FILE",
    );
  }

  const operationCount = Array.isArray(journal.operations) ? journal.operations.length : 0;
  const completedCount = Array.isArray(journal.completed) ? journal.completed.length : 0;
  if (completedCount >= operationCount) return;

  if (recoveryMode === "clean") {
    removeStaleJournal(stashDir, journal, warnings);
    warnings.push(
      `Removed stale consolidation journal at ${journalPath} (${completedCount}/${operationCount} operations completed).`,
    );
    return;
  }

  const backupHint =
    typeof journal.backupTimestamp === "string" && journal.backupTimestamp.trim().length > 0
      ? ` Backup dir: ${getBackupDir(stashDir, journal.backupTimestamp.trim())}.`
      : "";
  throw new ConfigError(
    `Incomplete consolidation run detected at ${journalPath} (${completedCount}/${operationCount} operations completed). Re-run with --consolidate-recovery clean to remove stale journal artifacts.${backupHint}`,
    "INVALID_CONFIG_FILE",
  );
}

function writeJournal(stashDir: string, ops: ConsolidateOperation[], backupTimestamp: string): void {
  const journalPath = getJournalPath(stashDir);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const journal: ConsolidateJournal = {
    startedAt: new Date().toISOString(),
    operations: ops,
    completed: [],
    backupTimestamp,
  };
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");
}

function markJournalCompleted(stashDir: string, opRef: string): void {
  const journalPath = getJournalPath(stashDir);
  if (!fs.existsSync(journalPath)) return;
  try {
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as ConsolidateJournal;
    journal.completed.push(opRef);
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

function cleanupJournal(stashDir: string, timestamp: string): void {
  const journalPath = getJournalPath(stashDir);
  try {
    fs.unlinkSync(journalPath);
  } catch {
    // ignore
  }
  const backupDir = getBackupDir(stashDir, timestamp);
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function backupFile(filePath: string, backupDir: string, name: string): void {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(backupDir, `${name}.md`));
  } catch {
    // best-effort
  }
}

// ── Archive helper (P1-B: soft-invalidation) ─────────────────────────────────

/**
 * Move a memory asset to `.akm/archive/` with `status: superseded` frontmatter
 * instead of deleting it outright. The live stash delete still happens after
 * this call — this is belt-and-suspenders archival that survives the hard delete.
 *
 * Archive filename: `<iso-ts>-<opIndex>-<basename>.md`
 * New frontmatter fields: status, superseded_at, superseded_by (optional),
 * superseded_reason.
 */
function archiveMemory(
  filePath: string,
  stashDir: string,
  ref: string,
  reason: string,
  opIndex: number,
  supersededBy?: string,
  warnings?: string[],
): void {
  const archiveDir = path.join(stashDir, ".akm", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    if (warnings) warnings.push(`archiveMemory: could not read ${ref} for archiving — skipping archive write`);
    return;
  }
  let content = raw;
  try {
    const parsed = parseFrontmatter(raw);
    const newFm: Record<string, unknown> = {
      ...parsed.data,
      status: "superseded",
      superseded_at: new Date().toISOString(),
      ...(supersededBy ? { superseded_by: supersededBy } : {}),
      superseded_reason: reason,
    };
    const fmStr = yamlStringify(newFm).trimEnd();
    content = `---\n${fmStr}\n---\n${parsed.content}`;
  } catch {
    if (warnings) warnings.push(`archiveMemory: could not parse frontmatter for ${ref} — archiving raw`);
  }
  const ts = timestampForFilename();
  const safeName = path.basename(filePath, ".md");
  const archivePath = path.join(archiveDir, `${ts}-${opIndex}-${safeName}.md`);
  try {
    fs.writeFileSync(archivePath, content, "utf8");
  } catch (e) {
    if (warnings) warnings.push(`archiveMemory: write failed for ${ref}: ${String(e)}`);
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function akmConsolidate(opts: AkmConsolidateOptions = {}): Promise<ConsolidateResult> {
  const startMs = Date.now();
  const config = opts.config ?? loadConfig();
  const stashDir = opts.stashDir ?? resolveStashDir();

  if (!isLlmFeatureEnabled(config, "memory_consolidation")) {
    return {
      schemaVersion: 1 as const,
      ok: true,
      shape: "consolidate-result" as const,
      dryRun: opts.dryRun ?? false,
      previewOnly: false,
      target: opts.target ?? stashDir,
      processed: 0,
      merged: 0,
      deleted: 0,
      promoted: [],
      contradicted: 0,
      warnings: [],
      durationMs: Date.now() - startMs,
    };
  }

  const warnings: string[] = [];
  checkForIncompleteJournal(stashDir, opts.recoveryMode ?? "abort", warnings);

  const memories = loadMemoriesForSource(opts.target, stashDir, warnings);

  if (memories.length === 0) {
    return {
      schemaVersion: 1 as const,
      ok: true,
      shape: "consolidate-result",
      dryRun: opts.dryRun ?? false,
      previewOnly: false,
      target: opts.target ?? stashDir,
      processed: 0,
      merged: 0,
      deleted: 0,
      promoted: [],
      contradicted: 0,
      warnings,
      durationMs: Date.now() - startMs,
    };
  }

  // Consolidation always uses the HTTP LLM client directly — never the agent
  // CLI. The agent CLI is for interactive agent sessions (reflect, propose);
  // structured JSON generation works better and faster via HTTP.
  const llmConfig = getDefaultLlmConfig(config);
  const isHttpPath = !!llmConfig;

  // Chunk sizing: derive a safe chunk size from the configured model context
  // window so that the full prompt (system prompt + chunk user prompt) never
  // exceeds the model's n_ctx limit.  When no context length is configured we
  // fall back to DEFAULT_CONTEXT_LENGTH_TOKENS (8 000) which is conservative
  // enough for most 8K–16K local models.
  //
  // bodyTruncation caps the body excerpt included per memory in the prompt.
  // Reducing it further than 500 chars degrades consolidation quality, so we
  // keep it fixed and let computeSafeChunkSize vary the number of memories
  // per chunk instead.
  const bodyTruncation = 500;
  const modelContextLength = llmConfig?.contextLength ?? DEFAULT_CONTEXT_LENGTH_TOKENS;
  const chunkSize = computeSafeChunkSize(modelContextLength, bodyTruncation);

  // -- Phase A: plan generation -----------------------------------------------
  const sourceName = opts.target ?? stashDir;

  // C-1 / #380: Pre-cluster memories by embedding similarity before chunking.
  // This ensures that semantically similar memories land in the same LLM
  // context window, allowing the model to detect and merge duplicates that
  // would otherwise be split across chunks and survive indefinitely.
  // mem0 arXiv:2504.19413, A-MEM arXiv:2502.12110.
  // Fails open: if embeddings are unavailable or fail, original order is used.
  const clusteredMemories = await clusterMemoriesBySimilarity(memories, config);

  const chunks: MemoryEntry[][] = [];
  for (let i = 0; i < clusteredMemories.length; i += chunkSize) {
    chunks.push(clusteredMemories.slice(i, i + chunkSize));
  }

  warn(`[consolidate] ${memories.length} memories / ${chunks.length} chunk(s) / chunk_size=${chunkSize}`);

  const chunkOpsArrays: ConsolidateOperation[][] = [];
  // C-6 / #392: Replace two-consecutive-failures abort with failure-rate threshold.
  // Consecutive-count policies are brittle against transient LM Studio reloads:
  // two transient failures abort the run even though the next chunk would succeed.
  // Rate-based abort (≥50% failure over ≥4 chunks) is more robust.
  // Tanenbaum, Distributed Systems §8 — rate-based policies with minimum sample sizes.
  let totalChunksProcessed = 0;
  let totalChunksFailed = 0;
  const ABORT_MIN_CHUNKS = 4;
  const ABORT_FAILURE_RATE = 0.5;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    // Abort if failure rate >= 50% over at least 4 processed chunks.
    if (totalChunksProcessed >= ABORT_MIN_CHUNKS) {
      const failureRate = totalChunksFailed / totalChunksProcessed;
      if (failureRate >= ABORT_FAILURE_RATE) {
        const skipped = chunks.length - chunkIdx;
        warnings.push(
          `Consolidation aborted — failure rate ${(failureRate * 100).toFixed(0)}% over ${totalChunksProcessed} chunks (>= ${ABORT_FAILURE_RATE * 100}% threshold). LLM may be unavailable. ${skipped} chunk(s) skipped.`,
        );
        break;
      }
    }

    const chunk = chunks[chunkIdx];
    warn(`[consolidate] chunk ${chunkIdx + 1}/${chunks.length} (${chunk.length} memories) …`);
    const userPrompt = buildChunkPrompt(sourceName, chunk, chunkIdx, chunks.length, bodyTruncation);

    const raw = await tryLlmFeature(
      "memory_consolidation",
      config,
      async () => {
        if (!llmConfig) return { ok: false as const, error: "No LLM configured for consolidation" };
        try {
          // responseSchema lift (PR 1, asset-writers-investigation §5): pass
          // the consolidate plan schema so providers with
          // `supportsJsonSchema: true` enforce shape upstream. Providers that
          // ignore the option fall through to the existing
          // `parseEmbeddedJsonResponse` path on the response side.
          const content = await chatCompletion(
            llmConfig,
            [
              { role: "system", content: CONSOLIDATE_SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
            { responseSchema: CONSOLIDATE_PLAN_JSON_SCHEMA },
          );
          return { ok: true as const, content };
        } catch (e) {
          return { ok: false as const, error: String(e) };
        }
      },
      { ok: false as const, error: `chunk ${chunkIdx + 1} failed` },
    );

    if (!raw.ok) {
      warnings.push(raw.error ?? `chunk ${chunkIdx + 1} failed`);
      totalChunksProcessed++;
      totalChunksFailed++;
      continue;
    }

    if (process.env.AKM_DEBUG_LLM) {
      const preview = (raw.content ?? "").slice(0, 500);
      warn(`[akm:consolidate] chunk ${chunkIdx + 1} raw response (first 500 chars): ${preview}`);
    }

    const parsed = parseEmbeddedJsonResponse<RawChunkPlan>(raw.content);
    if (!parsed || !Array.isArray(parsed.operations)) {
      const hint =
        raw.content !== undefined && raw.content.trim() === ""
          ? " (empty response — if using a thinking model, disable thinking mode)"
          : "";
      warnings.push(`Chunk ${chunkIdx + 1}: invalid plan from AI — skipping.${hint}`);
      totalChunksProcessed++;
      totalChunksFailed++;
      continue;
    }

    totalChunksProcessed++; // success

    const ops: ConsolidateOperation[] = [];
    for (const op of parsed.operations) {
      if (isValidOp(op)) {
        ops.push(op);
      } else {
        warnings.push(`Chunk ${chunkIdx + 1}: skipping invalid operation: ${JSON.stringify(op)}`);
      }
    }
    if (Array.isArray(parsed.warnings)) {
      for (const w of parsed.warnings) {
        if (typeof w === "string") warnings.push(w);
      }
    }

    chunkOpsArrays.push(ops);
  }

  const { ops: allOps, warnings: mergeWarnings } = mergePlans(chunkOpsArrays);
  warnings.push(...mergeWarnings);

  // -- Dry-run: show AI plan without executing any writes --------------------
  if (opts.dryRun) {
    return {
      schemaVersion: 1 as const,
      ok: true,
      shape: "consolidate-result",
      dryRun: true,
      previewOnly: true,
      target: sourceName,
      processed: memories.length,
      merged: 0,
      deleted: 0,
      promoted: [],
      contradicted: 0,
      planned: allOps,
      warnings,
      durationMs: Date.now() - startMs,
    };
  }

  warn(`[consolidate] plan: ${allOps.length} operation(s)`);

  // -- HTTP path: warn about quality and confirm unless auto-accepted --------
  if (isHttpPath) {
    warnings.push("Running on HTTP path — plan generated from truncated memory excerpts; quality may vary.");
    // TODO(confidence-scoring): once proposals expose a per-operation
    // confidence score, compare it against `opts.autoAccept` instead of
    // treating any defined threshold as a whole-batch accept. Until then,
    // any non-undefined threshold behaves like the legacy `"safe"` mode.
    if (opts.autoAccept === undefined && allOps.length > 0) {
      const n = allOps.length;
      // Non-interactive contexts (CI / test runners / piped stdin) must not
      // block on an unanswerable prompt. Default to a non-destructive "no"
      // so callers in those contexts get the same "aborted, preview only"
      // shape they'd get from explicit user dismissal. AKM_NON_INTERACTIVE
      // lets callers force this path even when stdin happens to be a TTY.
      const nonInteractive = process.stdin.isTTY === false || process.env.AKM_NON_INTERACTIVE === "1";
      const answer = nonInteractive ? false : await promptConfirm(`Apply ${n} operations? [y/N] `);
      if (!answer) {
        return {
          schemaVersion: 1 as const,
          ok: true,
          shape: "consolidate-result",
          dryRun: false,
          previewOnly: true,
          target: sourceName,
          processed: memories.length,
          merged: 0,
          deleted: 0,
          promoted: [],
          contradicted: 0,
          planned: allOps,
          warnings: [...warnings, nonInteractive ? "Non-interactive context: skipped apply." : "Aborted by user."],
          durationMs: Date.now() - startMs,
        };
      }
    }
  }

  // -- Phase B + writes -------------------------------------------------------
  const target = resolveWriteTarget(config);
  const timestamp = timestampForFilename();
  const backupDir = getBackupDir(stashDir, timestamp);

  // Write journal before any mutations
  writeJournal(stashDir, allOps, timestamp);

  let merged = 0;
  let deleted = 0;
  const promoted: string[] = [];
  let contradicted = 0; // C-3 / #382: count of contradiction edges written

  // Within-run dedup: track source refs for which a promote proposal was
  // already created this run. The LLM can return multiple promote ops for
  // different source memories that happen to have identical content (all are
  // duplicate memories), so we also need a content-hash guard below.
  const promotedSourceRefs = new Set<string>();

  // Build a lookup map: ref → MemoryEntry
  const memoryByRef = new Map<string, MemoryEntry>();
  for (const m of memories) {
    memoryByRef.set(`memory:${m.name}`, m);
  }

  for (let opIndex = 0; opIndex < allOps.length; opIndex++) {
    const op = allOps[opIndex];
    const opDisplayRef =
      op.op === "merge" ? op.primary : op.op === "contradict" ? `${op.ref} ↔ ${op.contradictedByRef}` : op.ref;
    warn(`[consolidate] ${opIndex + 1}/${allOps.length} ${op.op} ${opDisplayRef}`);
    if (op.op === "merge") {
      const primaryEntry = memoryByRef.get(op.primary);
      if (!primaryEntry) {
        warnings.push(`Merge: primary ${op.primary} not found in loaded memories — skipping.`);
        continue;
      }

      // Phase B: generate merged content
      const secondaryBodies: string[] = [];
      for (const secRef of op.secondaries) {
        const secEntry = memoryByRef.get(secRef);
        if (!secEntry) {
          warnings.push(`Merge: secondary ${secRef} not found — skipping merge op.`);
          continue;
        }
        secondaryBodies.push(secRef);
      }

      if (secondaryBodies.length === 0) continue;

      let primaryBody = "";
      try {
        primaryBody = fs.readFileSync(primaryEntry.filePath, "utf8");
      } catch {
        warnings.push(`Merge: could not read primary ${op.primary} — skipping.`);
        continue;
      }

      const mergedContent = await generateMergedContent(
        config,
        op.primary,
        primaryBody,
        op.secondaries,
        memoryByRef,
        warnings,
      );

      if (mergedContent === null) continue;

      // Validate frontmatter of merged content — must have a `---` block
      // with at minimum a `description` field. We parse via the hand-rolled
      // parser (cheap) AND require non-empty description. This guards against
      // the historical defect where merged memories were written back with
      // empty `description` and later polluted the promote path.
      let parsedMerged: ReturnType<typeof parseFrontmatter>;
      try {
        parsedMerged = parseFrontmatter(mergedContent);
      } catch {
        warnings.push(`Merge: merged content for ${op.primary} has invalid frontmatter — skipping.`);
        continue;
      }
      if (parsedMerged.frontmatter === null) {
        warnings.push(`Merge: merged content for ${op.primary} has no frontmatter block — skipping.`);
        continue;
      }
      const mergedDesc = parsedMerged.data.description;
      if (typeof mergedDesc !== "string" || mergedDesc.trim().length === 0) {
        warnings.push(`Merge: merged content for ${op.primary} missing description — skipping.`);
        continue;
      }
      const truncReason = detectTruncatedDescription(mergedDesc);
      if (truncReason) {
        warnings.push(`Merge: merged content for ${op.primary} has truncated description (${truncReason}) — skipping.`);
        continue;
      }

      // captureMode:hot guard — refuse the merge if ANY participating memory
      // (primary or secondary) was user-captured. Hot memories are user-
      // explicit and must not be deleted/overwritten by the consolidate LLM.
      // 14 user memories were silent-deleted by consolidate before this guard
      // landed; recovery required copying from .akm/archive/ by hand.
      const mergeParticipants: string[] = [op.primary, ...op.secondaries];
      const hotParticipants = mergeParticipants.filter((ref) => {
        const e = memoryByRef.get(ref);
        return e ? isHotCapturedMemory(e.filePath) : false;
      });
      if (hotParticipants.length > 0) {
        warnings.push(
          `Merge: refused for ${op.primary} — ${hotParticipants.length} participant(s) have captureMode:hot (user-explicit, never auto-merge): ${hotParticipants.join(", ")}`,
        );
        continue;
      }

      // Backup secondaries before deleting
      for (const secRef of op.secondaries) {
        const secEntry = memoryByRef.get(secRef);
        if (secEntry && fs.existsSync(secEntry.filePath)) {
          backupFile(secEntry.filePath, backupDir, secEntry.name);
        }
      }

      // Write merged primary
      try {
        const parsedPrimary = parseAssetRef(op.primary);
        await writeAssetToSource(target.source, target.config, parsedPrimary, mergedContent);
      } catch (e) {
        warnings.push(`Merge: write failed for ${op.primary}: ${String(e)}`);
        continue;
      }

      // Archive and delete secondaries (P1-B: soft-invalidation)
      for (const secRef of op.secondaries) {
        const secEntry = memoryByRef.get(secRef);
        if (!secEntry) continue;
        if (fs.existsSync(secEntry.filePath)) {
          archiveMemory(secEntry.filePath, stashDir, secRef, "merged into primary", opIndex, op.primary, warnings);
        }
        try {
          const parsedSec = parseAssetRef(secRef);
          await deleteAssetFromSource(target.source, target.config, parsedSec);
          markJournalCompleted(stashDir, secRef);
        } catch (e) {
          warnings.push(`Merge: delete failed for ${secRef}: ${String(e)}`);
        }
      }

      markJournalCompleted(stashDir, op.primary);
      merged++;
    } else if (op.op === "delete") {
      const entry = memoryByRef.get(op.ref);
      if (!entry) {
        warnings.push(`Delete: ${op.ref} not found in loaded memories — skipping.`);
        continue;
      }

      // captureMode:hot guard — refuse to delete user-captured memories.
      // The consolidate LLM was deleting hot-captured user memos as
      // "redundant" — 14 such deletes were silently archived between
      // 2026-05-19 and 2026-05-20 before this guard. Hot memories are
      // user-explicit and may only be deleted by the user.
      if (isHotCapturedMemory(entry.filePath)) {
        warnings.push(
          `Delete: refused for ${op.ref} — captureMode:hot (user-explicit; never auto-delete). Reason from LLM: "${op.reason ?? "n/a"}"`,
        );
        continue;
      }

      if (fs.existsSync(entry.filePath)) {
        backupFile(entry.filePath, backupDir, entry.name);
        // P1-B: soft-invalidation archive before hard delete
        archiveMemory(entry.filePath, stashDir, op.ref, op.reason, opIndex, undefined, warnings);
      }

      try {
        const parsedRef = parseAssetRef(op.ref);
        await deleteAssetFromSource(target.source, target.config, parsedRef);
        markJournalCompleted(stashDir, op.ref);
        deleted++;
      } catch (e) {
        warnings.push(`Delete: failed for ${op.ref}: ${String(e)}`);
      }
    } else if (op.op === "promote") {
      const entry = memoryByRef.get(op.ref);
      if (!entry) {
        warnings.push(`Promote: ${op.ref} not found in loaded memories — skipping.`);
        continue;
      }

      // Within-run source-ref dedup: skip if this source memory was already
      // promoted earlier in this run (safety belt — mergePlans already
      // deduplicates promote ops by source ref via Map, but this guard also
      // catches any future code paths that bypass mergePlans).
      if (promotedSourceRefs.has(op.ref)) {
        warnings.push(`Skipping promote: ${op.ref} already promoted in this run`);
        continue;
      }

      let knowledgeRef = op.knowledgeRef;
      try {
        parseAssetRef(knowledgeRef);
      } catch {
        const slug = op.knowledgeRef
          .replace(/^knowledge:/, "")
          .replace(/[^a-z0-9-]/gi, "-")
          .toLowerCase();
        knowledgeRef = `knowledge:${slug}`;
        warnings.push(`Normalized invalid ref "${op.knowledgeRef}" → "${knowledgeRef}"`);
      }

      // Idempotency: check pending proposals by target ref
      const existingProposals = listProposals(stashDir, { ref: knowledgeRef });
      if (existingProposals.some((p) => p.status === "pending")) {
        warnings.push(`Skipping promote: pending proposal already exists for ${knowledgeRef}`);
        continue;
      }

      // Idempotency: check if knowledge asset already exists
      const parsedKnowledgeRef = parseAssetRef(knowledgeRef);
      const destPath = path.join(target.source.path, "knowledge", `${parsedKnowledgeRef.name}.md`);
      if (fs.existsSync(destPath)) {
        warnings.push(`Skipping promote: ${knowledgeRef} already exists in source`);
        continue;
      }

      let memoryContent = "";
      try {
        memoryContent = fs.readFileSync(entry.filePath, "utf8");
      } catch (e) {
        warnings.push(`Promote: could not read ${op.ref}: ${String(e)}`);
        continue;
      }

      // Defensive sanitization: legacy memory files written by older
      // consolidate runs may still carry outer code fences or broken YAML.
      // Strip them here so we never propose a polluted asset.
      const promoteSanitized = sanitizeMergedContent(memoryContent);
      if (!promoteSanitized.ok) {
        warnings.push(`Promote: rejected ${op.ref} — source memory failed sanitization (${promoteSanitized.reason}).`);
        continue;
      }
      memoryContent = promoteSanitized.result.content;

      // SOURCE_SUPERSEDED guard: refuse to promote a memory whose source
      // frontmatter carries `status: superseded`. Predicate at module top
      // (`hasSupersededStatus`) so tests can exercise it directly.
      if (hasSupersededStatus(promoteSanitized.result.frontmatter as Record<string, unknown> | undefined)) {
        warnings.push(
          `Promote: refused for ${op.ref} → ${knowledgeRef} — source memory has status:superseded; superseded memories are not promotable knowledge.`,
        );
        continue;
      }

      // Cross-run + within-run content dedup: if an identical payload already
      // exists in ANY pending consolidate proposal (regardless of target ref),
      // skip. This prevents duplicate proposals when:
      //   (a) Multiple source memories have identical content (duplicate memories
      //       that were not merged) and each gets a different knowledgeRef from
      //       the LLM in the same run.
      //   (b) A prior run created a proposal for the same content under a
      //       different knowledgeRef slug.
      // We use SHA-256 of the raw file content — same algorithm as createProposal's
      // internal contentHash so the comparison is consistent.
      const newContentHash = createHash("sha256").update(memoryContent, "utf8").digest("hex");
      const allPendingConsolidateProposals = listProposals(stashDir, { status: "pending" }).filter(
        (p) => p.source === "consolidate",
      );
      const contentDupProposal = allPendingConsolidateProposals.find(
        (p) => createHash("sha256").update(p.payload.content, "utf8").digest("hex") === newContentHash,
      );
      if (contentDupProposal) {
        warnings.push(
          `Skipping promote: identical content already pending as proposal ${contentDupProposal.id} (ref: ${contentDupProposal.ref}); skipping duplicate for ${op.ref} → ${knowledgeRef}`,
        );
        continue;
      }

      try {
        // Use LLM-provided description; fall back to memory's own description
        // (post-sanitization frontmatter is authoritative).
        const parsedMemory = parseFrontmatter(memoryContent);
        const description: string =
          (typeof op.description === "string" && op.description.trim()
            ? op.description.trim()
            : (parsedMemory.data?.description as string | undefined)?.trim()) ?? "";

        // Validate the resolved frontmatter before emitting a proposal.
        // Required field: non-empty description. Reject obvious truncation
        // markers (description ends with `,`/`;`/`:`/`...`/hanging connector)
        // so the queue never sees half-formed metadata that the reviewer
        // would only reject.
        const fmCheck = validateProposalFrontmatter({ description });
        if (!fmCheck.ok) {
          warnings.push(`Promote: rejected ${op.ref} → ${knowledgeRef} — ${fmCheck.reason}.`);
          continue;
        }

        // (Body-frontmatter check REMOVED 2026-05-20: zero observed fires
        // across 17 sampled runs, and structurally redundant with
        // sanitizeMergedContent which already round-trips the body
        // frontmatter through the yaml library. The body and envelope
        // frontmatter come from the same `parsedMemory.data` object in this
        // scope, so the outer `validateProposalFrontmatter({ description })`
        // call above is sufficient.)

        // Pre-emit dedup against pending consolidate proposals from the
        // same improve run (slug-variant match). The cross-run content-hash
        // dedup inside `mergePlans` handles duplicates against existing
        // stash assets — see commit history for the deletion of the
        // unbounded embedding + cross-type slug branches.
        const dedup = await checkPreEmitDedup({
          candidateRef: knowledgeRef,
          candidateText: `${description}. ${memoryContent}`,
          stashDir,
          config,
        });
        if (dedup.duplicate) {
          warnings.push(`Promote: skipped ${op.ref} → ${knowledgeRef} — ${dedup.reason}.`);
          continue;
        }

        const proposalResult = createProposal(stashDir, {
          ref: knowledgeRef,
          source: "consolidate",
          payload: {
            content: memoryContent,
            frontmatter: { description },
          },
        });
        if (isProposalSkipped(proposalResult)) {
          warnings.push(
            `Promote: skipped proposal for ${op.ref} (${proposalResult.reason}): ${proposalResult.message}`,
          );
        } else {
          promoted.push(proposalResult.id);
          promotedSourceRefs.add(op.ref);
          markJournalCompleted(stashDir, op.ref);
        }
      } catch (e) {
        warnings.push(`Promote: createProposal failed for ${op.ref}: ${String(e)}`);
      }
    } else if (op.op === "contradict") {
      // C-3 / #382: Write contradictedBy edges so resolveFamilyContradictions
      // (the SCC resolver in memory-improve.ts) has edges to work on.
      // Zep arXiv:2501.13956 §3 — unified belief-revision with contradiction edges.
      const entry = memoryByRef.get(op.ref);
      const contradictorEntry = memoryByRef.get(op.contradictedByRef);

      if (!entry) {
        warnings.push(`Contradict: ${op.ref} not found in loaded memories — skipping.`);
        continue;
      }
      if (!contradictorEntry) {
        warnings.push(`Contradict: ${op.contradictedByRef} not found — skipping.`);
        continue;
      }

      try {
        // Write the contradiction edge: op.ref is contradicted by op.contradictedByRef
        writeContradictEdge(entry.filePath, op.contradictedByRef);
        contradicted++;
        markJournalCompleted(stashDir, op.ref);
      } catch (e) {
        warnings.push(`Contradict: failed to write edge for ${op.ref}: ${String(e)}`);
      }
    }
  }

  cleanupJournal(stashDir, timestamp);

  // TTL cleanup: remove archive entries older than archiveRetentionDays (default 90).
  // C-5 / #391: emit an `archive_cleanup` event before each deletion so the
  // audit trail records what was lost. Outbox pattern (EIP, Hohpe-Woolf) —
  // any event that is recorded must be queryable; silent deletes are an anti-pattern.
  const archiveDir = path.join(stashDir, ".akm", "archive");
  if (fs.existsSync(archiveDir)) {
    const retentionMs = (config.archiveRetentionDays ?? 90) * 86_400_000;
    const cutoff = Date.now() - retentionMs;
    for (const fname of fs.readdirSync(archiveDir)) {
      const fp = path.join(archiveDir, fname);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          // Emit event before deletion so the record survives the purge.
          appendEvent({
            eventType: "archive_cleanup",
            metadata: {
              file: fname,
              filePath: fp,
              ageMs: Date.now() - stat.mtimeMs,
              retentionMs,
            },
          });
          fs.unlinkSync(fp);
        }
      } catch {
        /* ignore race conditions */
      }
    }
  }

  return {
    schemaVersion: 1 as const,
    ok: true,
    shape: "consolidate-result",
    dryRun: false,
    previewOnly: false,
    target: sourceName,
    processed: memories.length,
    merged,
    deleted,
    promoted,
    contradicted,
    warnings,
    durationMs: Date.now() - startMs,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// ── LLM-output sanitization ─────────────────────────────────────────────────
//
// Three classes of LLM defect have been observed across hundreds of
// consolidate proposals (see audit notes in this branch):
//
//   1. Code-fence leakage: the entire merged asset is wrapped in
//      ```markdown … ``` (or ```yaml … ```) despite the prompt forbidding
//      fences. The post-processor used to pass this through verbatim, so the
//      first character of the asset content became a backtick rather than
//      `---`, defeating the frontmatter parser.
//   2. YAML quote-escaping bugs: descriptions like `'"Specialty intro...:`
//      with unbalanced quotes that break the YAML reader. The post-processor
//      historically passed the LLM's raw scalar straight into a manually
//      assembled `description: <raw>` line.
//   3. Truncated descriptions hitting token cutoffs — the model's max_tokens
//      runs out mid-sentence, leaving things like
//      `description: "Tables in narrow column containers need max-width:100% +"`
//      with no closing context.
//
// `sanitizeMergedContent` and `validateProposalFrontmatter` defend against
// all three at the point where LLM output is consumed.

/**
 * Outer-fence stripper specific to consolidate. Unlike the shared
 * `stripMarkdownFences` helper (which only handles markdown fences), this
 * variant additionally recognises `yaml` and bare-language fences and refuses
 * to strip an unbalanced fence — i.e. a leading ``` with no trailing ``` is
 * treated as a malformed response, not partially sanitized.
 *
 * Returns `null` when only one half of a fence pair is present (caller
 * should reject the response entirely).
 */
export function stripOuterCodeFence(raw: string): { content: string; stripped: boolean } | null {
  const trimmed = raw.trim();
  const leading = trimmed.match(/^```(?:markdown|md|yaml|yml)?\s*\r?\n/i);
  const trailing = trimmed.match(/\r?\n```\s*$/);
  if (!leading && !trailing) return { content: trimmed, stripped: false };
  if (!leading || !trailing) return null; // unbalanced — refuse
  const inner = trimmed.slice(leading[0].length, trimmed.length - trailing[0].length).trim();
  return { content: inner, stripped: true };
}

/**
 * Sanitize raw LLM output destined to be written as an asset body:
 *   1. Strip outer code fences (rejects unbalanced fences).
 *   2. Verify the remaining payload starts with `---\n` (frontmatter sentinel).
 *   3. Re-serialise the frontmatter via the `yaml` library so any unbalanced
 *      quoting or odd escaping the LLM produced gets normalised. If yaml.parse
 *      throws, return `null` — the response is unusable.
 */
export interface SanitizedMergedContent {
  /** Clean markdown with re-serialised frontmatter. */
  content: string;
  /** Parsed frontmatter object (after yaml round-trip). */
  frontmatter: Record<string, unknown>;
}

export function sanitizeMergedContent(
  raw: string,
): { ok: true; result: SanitizedMergedContent } | { ok: false; reason: string } {
  const fenceResult = stripOuterCodeFence(raw);
  if (!fenceResult) {
    return { ok: false, reason: "UNBALANCED_CODE_FENCE" };
  }
  let body = fenceResult.content;

  // Strip <think> blocks (some local models still emit them despite system prompts).
  body = body.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  if (!body.startsWith("---")) {
    return { ok: false, reason: "MISSING_FRONTMATTER_SENTINEL" };
  }

  // Extract frontmatter block.
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r\n|\r|\n|$)([\s\S]*)$/);
  if (!match) {
    return { ok: false, reason: "MALFORMED_FRONTMATTER_BLOCK" };
  }

  // Re-parse via the yaml library so any quote-escaping mistakes either get
  // normalised or surface as a parse error we can reject.
  let parsedFm: unknown;
  try {
    parsedFm = yamlParse(match[1]);
  } catch (e) {
    return { ok: false, reason: `INVALID_YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsedFm === null || typeof parsedFm !== "object" || Array.isArray(parsedFm)) {
    return { ok: false, reason: "FRONTMATTER_NOT_OBJECT" };
  }
  const fm = parsedFm as Record<string, unknown>;

  // Normalise placeholder leaks like `updated: today`, `updated: {today: null}`,
  // `updated: now`, etc. The consolidate prompt instructs the LLM not to emit
  // these, but small models still do. Replace any such leak with today's ISO
  // date OR drop the field if we can't safely normalise it.
  normalizeUpdatedField(fm);

  // Re-serialise via yaml.stringify to fix any quoting quirks.
  let serialized: string;
  try {
    serialized = yamlStringify(fm).trimEnd();
  } catch (e) {
    return { ok: false, reason: `YAML_STRINGIFY_FAILED: ${e instanceof Error ? e.message : String(e)}` };
  }

  const cleaned = `---\n${serialized}\n---\n${match[2]}`;
  return { ok: true, result: { content: cleaned, frontmatter: fm } };
}

/**
 * Mutate `fm.updated` in place to normalise placeholder leaks emitted by the
 * LLM. The consolidate prompt forbids these, but small models still produce
 * literal `today` / `{today: null}` / `now` values.
 *
 * Rules:
 *   - A real ISO-style date string (YYYY-MM-DD, optionally with time) stays as-is.
 *   - A Date object (some YAML parsers materialise dates) is converted to its
 *     ISO yyyy-mm-dd form.
 *   - A placeholder string ("today", "now", "{today}", "${today}", template
 *     variables) is replaced with today's ISO date.
 *   - A map/object (e.g. `{today: null}`) is replaced with today's ISO date.
 *   - `null`, empty string, missing → left alone (no field added; reviewers
 *     should not silently gain metadata they didn't write).
 *
 * Exported for unit testing.
 */
export function normalizeUpdatedField(fm: Record<string, unknown>): void {
  if (!("updated" in fm)) return;
  const v = fm.updated;
  if (v === null || v === undefined || v === "") return;
  const todayIso = new Date().toISOString().slice(0, 10);
  if (v instanceof Date) {
    fm.updated = v.toISOString().slice(0, 10);
    return;
  }
  if (typeof v === "string") {
    const trimmed = v.trim().toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return; // already a real date
    if (
      trimmed === "today" ||
      trimmed === "now" ||
      trimmed === "{today}" ||
      // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the literal user-typed placeholder text "${today}" so we can normalize it to today's ISO date
      trimmed === "${today}" ||
      trimmed === "{{today}}" ||
      /^\{?\s*today\s*\}?$/.test(trimmed)
    ) {
      fm.updated = todayIso;
      return;
    }
    // Unknown string format — leave alone so it's visible in the diff.
    return;
  }
  if (typeof v === "object") {
    // Maps like `{today: null}`, `{now: null}` — clearly a template leak.
    fm.updated = todayIso;
    return;
  }
}

/**
 * Normalise a knowledge slug for variant-aware deduplication. Collapses:
 *   - date suffixes (`-may-2026`, `-2026-05-03`, `-2026`)
 *   - numeric counter suffixes (`-2`, `-3`)
 *   - trailing -patterns / -2026-05-03 styles
 *   - word reorderings via alphabetical sort of the remaining tokens.
 *
 * Two slugs that normalise to the same string are considered the same asset
 * for dedup purposes even if they don't share an exact ref.
 */
export function normalizeSlugForDedup(ref: string): string {
  const slug = ref.replace(/^[^:]+:/, "");
  const monthRe = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
  const tokens = slug
    .toLowerCase()
    .split("-")
    .filter((tok) => tok.length > 0)
    // Strip purely-numeric tokens (years, dates, counter suffixes like -2 / -3).
    // Numbers carry no semantic information for our dedup purposes — every
    // observed defective slug variant differs only in dates or counters.
    .filter((tok) => !/^\d+$/.test(tok))
    .filter((tok) => !monthRe.test(tok));
  // Sort to absorb word reorderings.
  tokens.sort();
  return tokens.join("-");
}

/**
 * Pre-emit dedup check: compare the candidate ref against pending consolidate
 * proposals only. Returns a reason string if a slug-variant match is found,
 * else null.
 *
 * Historical context (REMOVED 2026-05-20): this function previously also ran
 *   (a) a normalised-slug match against existing knowledge AND memory entries
 *       in the DB, and
 *   (b) an embedding cosine-similarity check (>= 0.85) against ALL knowledge
 *       and non-derived memory entries.
 * Both branches had ZERO observed fires across 30 sampled runs in the
 * post-fix window. The 29 actual dedup catches all came from the SEPARATE
 * content-hash dedup inside `mergePlans` (the older SHA-256 helper). The
 * embedding branch in particular had unbounded cost per promote (embedded
 * every knowledge + non-derived memory entry, every time) with no observed
 * benefit. Empirical signal → deleted.
 *
 * What remains: a check against pending consolidate proposals in the SAME
 * improve run. This catches duplicates queued back-to-back within a single
 * improve invocation — a different concern from the cross-run content-hash
 * dedup, and cheap (no embeddings, no DB query).
 */
export async function checkPreEmitDedup(opts: {
  candidateRef: string;
  candidateText: string;
  stashDir: string;
  config: AkmConfig;
}): Promise<{ duplicate: true; reason: string } | { duplicate: false }> {
  const normCandidate = normalizeSlugForDedup(opts.candidateRef);

  // Pending consolidate proposals (slug match) — within the same improve run.
  const pendingConsolidate = listProposals(opts.stashDir, { status: "pending" }).filter(
    (p) => p.source === "consolidate",
  );
  for (const p of pendingConsolidate) {
    if (normalizeSlugForDedup(p.ref) === normCandidate) {
      return { duplicate: true, reason: `slug-variant of pending proposal ${p.id} (${p.ref})` };
    }
  }

  return { duplicate: false };
}

function loadMemoriesForSource(source: string | undefined, stashDir: string, warnings: string[]): MemoryEntry[] {
  // Load from DB first
  let memories: MemoryEntry[] = [];
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase();
    const entries: DbIndexedEntry[] = getAllEntries(db, "memory");
    memories = entries
      .filter((e) => {
        if (!source) return true;
        return path.resolve(e.stashDir) === path.resolve(source);
      })
      .filter((e) => isConsolidationEligibleMemoryName(e.entry.name))
      .map((e) => ({
        name: e.entry.name,
        filePath: e.filePath,
        description: e.entry.description ?? "",
        tags: e.entry.tags ?? [],
        stashDir: e.stashDir,
      }));
  } catch {
    memories = [];
  } finally {
    if (db) closeDatabase(db);
  }

  if (memories.length === 0) {
    // DB fallback: walk filesystem
    const memoriesDir = path.join(source ?? stashDir, "memories");
    const fsStashDir = source ?? stashDir;
    if (fs.existsSync(memoriesDir)) {
      for (const fname of fs.readdirSync(memoriesDir)) {
        if (!fname.endsWith(".md")) continue;
        const filePath = path.join(memoriesDir, fname);
        const name = fname.replace(/\.md$/, "");
        if (!isConsolidationEligibleMemoryName(name)) continue;
        memories.push({ name, filePath, description: "", tags: [], stashDir: fsStashDir });
      }
    }
    if (memories.length > 0) {
      warnings.push("DB not found or empty — loaded memories directly from filesystem.");
    }
  }
  return memories;
}

async function generateMergedContent(
  config: AkmConfig,
  primaryRef: string,
  primaryBody: string,
  secondaryRefs: string[],
  memoryByRef: Map<string, MemoryEntry>,
  warnings: string[],
): Promise<string | null> {
  // Only handle single-secondary merges per design (one call per merge op)
  const secRef = secondaryRefs[0];
  const secEntry = memoryByRef.get(secRef);
  if (!secEntry) return null;

  let secBody = "";
  try {
    secBody = fs.readFileSync(secEntry.filePath, "utf8");
  } catch {
    warnings.push(`Merge: could not read secondary ${secRef} — skipping.`);
    return null;
  }

  const prompt = [
    "Merge these two memory assets into one. Output ONLY the merged markdown (with YAML frontmatter). Do not explain, do not use code fences.",
    "",
    "## OUTPUT FORMAT (MANDATORY)",
    "Return raw markdown content beginning DIRECTLY with the `---` frontmatter delimiter.",
    "DO NOT wrap your entire response in a code fence.",
    "",
    'GOOD: "---\\ndescription: ...\\n---\\nBody content."',
    'BAD:  "```markdown\\n---\\ndescription: ...\\n---\\nBody content.\\n```"',
    'BAD:  "```yaml\\n---\\ndescription: ...\\n---\\nBody content.\\n```"',
    "",
    "- The `updated:` field, if present, MUST be a real ISO date (e.g. `updated: 2026-05-20`). NEVER emit `updated: today`, `updated: now`, or `updated: {today: null}`. If you don't have a real date, OMIT the field — the post-processor will not invent one.",
    "",
    `=== Primary memory (${primaryRef}) ===`,
    primaryBody,
    "",
    `=== Secondary memory (${secRef}) ===`,
    secBody,
  ].join("\n");

  const llmConfig = getDefaultLlmConfig(config);
  const result = await tryLlmFeature(
    "memory_consolidation",
    config,
    async () => {
      if (!llmConfig) return { ok: false as const, error: "No LLM configured for consolidation" };
      try {
        const content = await chatCompletion(llmConfig, [{ role: "user", content: prompt }]);
        return { ok: true as const, content };
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
    },
    { ok: false as const, error: `merge content generation failed for ${primaryRef}` },
  );

  if (!result.ok) {
    warnings.push(result.error ?? `merge content generation failed for ${primaryRef}`);
    return null;
  }

  // Sanitize LLM output: strip outer code fences (defends against the
  // ```markdown … ``` leak observed in production), re-serialise frontmatter
  // through the yaml lib (fixes quote-escaping mistakes), and reject empty
  // or fence-only responses.
  const sanitized = sanitizeMergedContent(result.content ?? "");
  if (!sanitized.ok) {
    warnings.push(`Merge: rejected LLM output for ${primaryRef} — ${sanitized.reason}.`);
    return null;
  }
  const mergedRaw = sanitized.result.content;

  // C-4 / #383: Content-preservation lint (mem0 §3.2, arXiv:2504.19413).
  // Guards against LLM-generated merged content that silently drops information
  // from the source assets. Two checks:
  //   1. Body size: merged body must be >= 50% of the larger source body.
  //   2. Frontmatter superset: merged frontmatter must contain all keys present
  //      in both source frontmatters.
  // Failures emit a warning and return null so the merge op is skipped rather
  // than writing degraded content.
  try {
    const primaryFm = parseFrontmatter(primaryBody);
    const secFm = parseFrontmatter(secBody);
    const mergedFm = parseFrontmatter(mergedRaw);

    // Check body size
    const primaryBodyLen = (primaryFm.content ?? "").trim().length;
    const secBodyLen = (secFm.content ?? "").trim().length;
    const mergedBodyLen = (mergedFm.content ?? "").trim().length;
    const largerBodyLen = Math.max(primaryBodyLen, secBodyLen);
    if (largerBodyLen > 0 && mergedBodyLen < largerBodyLen * 0.5) {
      warnings.push(
        `Merge: content-preservation lint failed for ${primaryRef} — ` +
          `merged body (${mergedBodyLen} chars) is less than 50% of larger source (${largerBodyLen} chars). ` +
          `Skipping merge to prevent data loss.`,
      );
      return null;
    }

    // Check frontmatter superset
    const primaryKeys = Object.keys(primaryFm.data ?? {});
    const secKeys = Object.keys(secFm.data ?? {});
    const mergedKeys = new Set(Object.keys(mergedFm.data ?? {}));
    const missingKeys = [...primaryKeys, ...secKeys].filter((k) => !mergedKeys.has(k));
    if (missingKeys.length > 0) {
      warnings.push(
        `Merge: content-preservation lint failed for ${primaryRef} — ` +
          `merged frontmatter missing keys from sources: ${missingKeys.join(", ")}. ` +
          `Skipping merge to prevent data loss.`,
      );
      return null;
    }
  } catch {
    // parseFrontmatter failures are non-fatal — allow the merge to proceed.
  }

  return mergedRaw;
}

async function promptConfirm(message: string): Promise<boolean> {
  process.stdout.write(message);
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", (line: string) => done(line.trim().toLowerCase() === "y"));
    rl.once("close", () => done(false));
  });
}
