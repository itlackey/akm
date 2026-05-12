import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { stringify as yamlStringify } from "yaml";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir } from "../core/common";
import type { AkmConfig } from "../core/config";
import { loadConfig } from "../core/config";
import { ConfigError } from "../core/errors";
import { parseFrontmatter } from "../core/frontmatter";
import { parseEmbeddedJsonResponse } from "../core/parse";
import { createProposal, listProposals } from "../core/proposals";
import { deleteAssetFromSource, resolveWriteTarget, writeAssetToSource } from "../core/write-source";
import type { DbIndexedEntry } from "../indexer/db";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../indexer/db";
import { callAi } from "../llm/call-ai";
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

function loadMemoriesFromDb(sourceFilterPath?: string): MemoryEntry[] {
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase();
    const entries: DbIndexedEntry[] = getAllEntries(db, "memory");
    return entries
      .filter((e) => {
        if (!sourceFilterPath) return true;
        return path.resolve(e.stashDir) === path.resolve(sourceFilterPath);
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
    return [];
  } finally {
    if (db) closeDatabase(db);
  }
}

function loadMemoriesFromFs(memoriesDir: string, stashDir: string): MemoryEntry[] {
  if (!fs.existsSync(memoriesDir)) return [];
  const entries: MemoryEntry[] = [];
  for (const fname of fs.readdirSync(memoriesDir)) {
    if (!fname.endsWith(".md")) continue;
    const filePath = path.join(memoriesDir, fname);
    const name = fname.replace(/\.md$/, "");
    if (!isConsolidationEligibleMemoryName(name)) continue;
    entries.push({ name, filePath, description: "", tags: [], stashDir });
  }
  return entries;
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
}

function getJournalPath(stashDir: string): string {
  return path.join(stashDir, ".akm", "consolidate-journal.json");
}

function getBackupDir(stashDir: string, timestamp: string): string {
  return path.join(stashDir, ".akm", "consolidate-backup", timestamp);
}

function checkForIncompleteJournal(stashDir: string): void {
  const journalPath = getJournalPath(stashDir);
  if (!fs.existsSync(journalPath)) return;
  let journal: ConsolidateJournal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as ConsolidateJournal;
  } catch {
    return;
  }
  if (journal.completed.length < journal.operations.length) {
    throw new ConfigError(
      "Incomplete consolidation run detected. Run akm consolidate --clean to remove the journal and backup, or --resume to retry (not yet implemented). Aborting.",
      "INVALID_CONFIG_FILE",
    );
  }
}

function writeJournal(stashDir: string, ops: ConsolidateOperation[]): void {
  const journalPath = getJournalPath(stashDir);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const journal: ConsolidateJournal = {
    startedAt: new Date().toISOString(),
    operations: ops,
    completed: [],
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
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
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

  checkForIncompleteJournal(stashDir);

  const warnings: string[] = [];

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

  const isAgentPath = !!config.agent;
  const isHttpPath = !isAgentPath && !!config.llm;

  // Chunk sizing: 20 memories per chunk with 500-char body truncation works
  // well across both agent-CLI and HTTP paths without overflowing local model
  // context windows (≈10k–12k chars per chunk for typical memories).
  // Both values are intentionally generous — reducing them causes silent
  // failures when memories are large. Override via future config fields if
  // needed.
  const bodyTruncation = 500;
  const chunkSize = 20;

  // -- Phase A: plan generation -----------------------------------------------
  const sourceName = opts.target ?? stashDir;
  const chunks: MemoryEntry[][] = [];
  for (let i = 0; i < memories.length; i += chunkSize) {
    chunks.push(memories.slice(i, i + chunkSize));
  }

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
    const userPrompt = buildChunkPrompt(sourceName, chunk, chunkIdx, chunks.length, bodyTruncation);

    const raw = await tryLlmFeature(
      "memory_consolidation",
      config,
      () => callAi(config, userPrompt, { systemPrompt: CONSOLIDATE_SYSTEM_PROMPT }),
      { ok: false as const, error: `chunk ${chunkIdx + 1} failed` },
    );

    if (!raw.ok) {
      warnings.push(raw.error ?? `chunk ${chunkIdx + 1} failed`);
      consecutiveFailures++;
      continue;
    }

    const parsed = parseEmbeddedJsonResponse<RawChunkPlan>(raw.content);
    if (!parsed || !Array.isArray(parsed.operations)) {
      warnings.push(`Chunk ${chunkIdx + 1}: invalid plan from AI — skipping.`);
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = getBackupDir(stashDir, timestamp);

  // Write journal before any mutations
  writeJournal(stashDir, allOps);

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
        const proposal = createProposal(stashDir, {
          ref: knowledgeRef,
          source: "consolidate",
          payload: { content: memoryContent },
        });
        promoted.push(proposal.id);
        markJournalCompleted(stashDir, op.ref);
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
  let memories = loadMemoriesFromDb(source ? resolveSourcePath(source) : undefined);
  if (memories.length === 0) {
    // DB fallback: walk filesystem
    const memoriesDir = path.join(source ?? stashDir, "memories");
    memories = loadMemoriesFromFs(memoriesDir, source ?? stashDir);
    if (memories.length > 0) {
      warnings.push("DB not found or empty — loaded memories directly from filesystem.");
    }
  }
  return memories;
}

function resolveSourcePath(sourceName: string): string {
  // If it looks like an absolute path, use directly
  if (path.isAbsolute(sourceName)) return sourceName;
  return sourceName;
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

  const result = await tryLlmFeature("memory_consolidation", config, () => callAi(config, prompt), {
    ok: false as const,
    error: `merge content generation failed for ${primaryRef}`,
  });

  if (!result.ok) {
    warnings.push(result.error ?? `merge content generation failed for ${primaryRef}`);
    return null;
  }

  return result.content;
}

async function promptConfirm(message: string): Promise<boolean> {
  process.stdout.write(message);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", (line: string) => {
      rl.close();
      resolve(line.trim().toLowerCase() === "y");
    });
  });
}
