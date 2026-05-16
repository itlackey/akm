import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { stringify as yamlStringify } from "yaml";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir, timestampForFilename } from "../core/common";
import type { AkmConfig } from "../core/config";
import { loadConfig } from "../core/config";
import { ConfigError } from "../core/errors";
import { parseFrontmatter } from "../core/frontmatter";
import { parseEmbeddedJsonResponse } from "../core/parse";
import { createProposal, isProposalSkipped, listProposals } from "../core/proposals";
import { warn } from "../core/warn";
import { deleteAssetFromSource, resolveWriteTarget, writeAssetToSource } from "../core/write-source";
import type { DbIndexedEntry } from "../indexer/db";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../indexer/db";
import { chatCompletion } from "../llm/client";
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
}

export type ConsolidateOperation = ConsolidateMergeOp | ConsolidateDeleteOp | ConsolidatePromoteOp;

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
  planned?: ConsolidateOperation[];
  warnings: string[];
  durationMs: number;
}

export interface AkmConsolidateOptions {
  target?: string; // which source to target; defaults to primary writable stash
  dryRun?: boolean; // generate AI plan but skip all writes
  autoAccept?: "safe"; // skip interactive confirmation (mirrors improve --auto-accept)
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
4. KEEP: Memory is unique and current → omit from output.

Return ONLY JSON (no prose, no code fences):
{
  "operations": [
    { "op": "merge", "primary": "memory:<name>", "secondaries": ["memory:<name>", ...], "mergeStrategy": "synthesize" },
    { "op": "delete", "ref": "memory:<name>", "reason": "<brief reason>" },
    { "op": "promote", "ref": "memory:<name>", "knowledgeRef": "knowledge:<suggested-slug>", "reason": "<brief reason>" }
  ],
  "warnings": ["<optional concerns>"]
}`;

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
 * Default effective token budget used when `config.llm.contextLength` is not
 * set. This is intentionally conservative (4 096) rather than being set to
 * the model's actual context window, because:
 *
 *   - When the agent path is used (config.agent), the agent CLI (e.g. opencode)
 *     prepends its own large system prompt + conversation history before
 *     forwarding to the model. That overhead easily consumes 30K+ tokens on
 *     a model with a 16K context window, leaving very little room for
 *     chunk content.
 *   - When the HTTP path is used (config.llm), only the akm system prompt and
 *     user prompt are sent, so the budget can be set to the model's actual
 *     context length via config.llm.contextLength.
 *
 * Set config.llm.contextLength in your config file to the model's actual
 * context window to allow larger chunks on the HTTP path.
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
  return false;
}

function mergePlans(chunks: ConsolidateOperation[][]): { ops: ConsolidateOperation[]; warnings: string[] } {
  const mergeOps = new Map<string, ConsolidateMergeOp>();
  const deleteOps = new Map<string, ConsolidateDeleteOp>();
  const promoteOps = new Map<string, ConsolidatePromoteOp>();
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
        const existingMerge = mergeOps.get(op.ref);
        if (existingMerge) {
          warnings.push(`Conflict: promote and merge both target ${op.ref}; preferring merge.`);
        } else {
          promoteOps.set(op.ref, op);
        }
      }
    }
  }

  const ops: ConsolidateOperation[] = [...mergeOps.values(), ...deleteOps.values(), ...promoteOps.values()];
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
      warnings,
      durationMs: Date.now() - startMs,
    };
  }

  // Consolidation always uses the HTTP LLM client directly — never the agent
  // CLI. The agent CLI is for interactive agent sessions (reflect, propose);
  // structured JSON generation works better and faster via HTTP.
  const isHttpPath = !!config.llm;

  // Chunk sizing: derive a safe chunk size from the configured model context
  // window (config.llm.contextLength) so that the full prompt (system prompt +
  // chunk user prompt) never exceeds the model's n_ctx limit.  When no context
  // length is configured we fall back to DEFAULT_CONTEXT_LENGTH_TOKENS (8 000)
  // which is conservative enough for most 8K–16K local models.
  //
  // bodyTruncation caps the body excerpt included per memory in the prompt.
  // Reducing it further than 500 chars degrades consolidation quality, so we
  // keep it fixed and let computeSafeChunkSize vary the number of memories
  // per chunk instead.
  const bodyTruncation = 500;
  const modelContextLength = config.llm?.contextLength ?? DEFAULT_CONTEXT_LENGTH_TOKENS;
  const chunkSize = computeSafeChunkSize(modelContextLength, bodyTruncation);

  // -- Phase A: plan generation -----------------------------------------------
  const sourceName = opts.target ?? stashDir;
  const chunks: MemoryEntry[][] = [];
  for (let i = 0; i < memories.length; i += chunkSize) {
    chunks.push(memories.slice(i, i + chunkSize));
  }

  warn(`[consolidate] ${memories.length} memories / ${chunks.length} chunk(s) / chunk_size=${chunkSize}`);

  const chunkOpsArrays: ConsolidateOperation[][] = [];
  let consecutiveFailures = 0;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    // Abort early if the first chunk failed — the LLM/agent is likely unavailable
    // and continuing would waste minutes processing chunks that will all fail the same way.
    if (chunkIdx > 0 && consecutiveFailures >= 2) {
      const skipped = chunks.length - chunkIdx;
      warnings.push(
        `Consolidation aborted after ${consecutiveFailures} consecutive chunk failures — LLM may be unavailable. ${skipped} chunk(s) skipped.`,
      );
      break;
    }

    const chunk = chunks[chunkIdx];
    warn(`[consolidate] chunk ${chunkIdx + 1}/${chunks.length} (${chunk.length} memories) …`);
    const userPrompt = buildChunkPrompt(sourceName, chunk, chunkIdx, chunks.length, bodyTruncation);

    const raw = await tryLlmFeature(
      "memory_consolidation",
      config,
      async () => {
        if (!config.llm) return { ok: false as const, error: "No LLM configured for consolidation" };
        try {
          const content = await chatCompletion(config.llm, [
            { role: "system", content: CONSOLIDATE_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ]);
          return { ok: true as const, content };
        } catch (e) {
          return { ok: false as const, error: String(e) };
        }
      },
      { ok: false as const, error: `chunk ${chunkIdx + 1} failed` },
    );

    if (!raw.ok) {
      warnings.push(raw.error ?? `chunk ${chunkIdx + 1} failed`);
      consecutiveFailures++;
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
      consecutiveFailures++;
      continue;
    }

    consecutiveFailures = 0; // reset on success

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
      planned: allOps,
      warnings,
      durationMs: Date.now() - startMs,
    };
  }

  warn(`[consolidate] plan: ${allOps.length} operation(s)`);

  // -- HTTP path: warn about quality and confirm unless auto-accepted --------
  if (isHttpPath) {
    warnings.push("Running on HTTP path — plan generated from truncated memory excerpts; quality may vary.");
    if (!opts.autoAccept) {
      const n = allOps.length;
      const answer = await promptConfirm(`Apply ${n} operations? [y/N] `);
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
          planned: allOps,
          warnings: [...warnings, "Aborted by user."],
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

  // Build a lookup map: ref → MemoryEntry
  const memoryByRef = new Map<string, MemoryEntry>();
  for (const m of memories) {
    memoryByRef.set(`memory:${m.name}`, m);
  }

  for (let opIndex = 0; opIndex < allOps.length; opIndex++) {
    const op = allOps[opIndex];
    warn(`[consolidate] ${opIndex + 1}/${allOps.length} ${op.op} ${op.op === "merge" ? op.primary : op.ref}`);
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

      // Validate frontmatter of merged content
      try {
        parseFrontmatter(mergedContent);
      } catch {
        warnings.push(`Merge: merged content for ${op.primary} has invalid frontmatter — skipping.`);
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

      // Idempotency: check pending proposals
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

      try {
        const proposalResult = createProposal(stashDir, {
          ref: knowledgeRef,
          source: "consolidate",
          payload: { content: memoryContent },
        });
        if (isProposalSkipped(proposalResult)) {
          warnings.push(
            `Promote: skipped proposal for ${op.ref} (${proposalResult.reason}): ${proposalResult.message}`,
          );
        } else {
          promoted.push(proposalResult.id);
          markJournalCompleted(stashDir, op.ref);
        }
      } catch (e) {
        warnings.push(`Promote: createProposal failed for ${op.ref}: ${String(e)}`);
      }
    }
  }

  cleanupJournal(stashDir, timestamp);

  // TTL cleanup: remove archive entries older than archiveRetentionDays (default 90)
  const archiveDir = path.join(stashDir, ".akm", "archive");
  if (fs.existsSync(archiveDir)) {
    const retentionMs = (config.archiveRetentionDays ?? 90) * 86_400_000;
    const cutoff = Date.now() - retentionMs;
    for (const fname of fs.readdirSync(archiveDir)) {
      const fp = path.join(archiveDir, fname);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
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
    warnings,
    durationMs: Date.now() - startMs,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

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
    `=== Primary memory (${primaryRef}) ===`,
    primaryBody,
    "",
    `=== Secondary memory (${secRef}) ===`,
    secBody,
  ].join("\n");

  const result = await tryLlmFeature(
    "memory_consolidation",
    config,
    async () => {
      if (!config.llm) return { ok: false as const, error: "No LLM configured for consolidation" };
      try {
        const content = await chatCompletion(config.llm, [{ role: "user", content: prompt }]);
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

  return result.content;
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
