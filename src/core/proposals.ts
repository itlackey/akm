/**
 * Proposal substrate (#225).
 *
 * One durable proposal store for every future reflection / generation flow
 * (`akm reflect`, `akm propose`, `akm distill`, lesson distillation, …).
 * Proposals are *queue state*, not source-of-truth assets — they sit on disk
 * waiting for human (or automated) review and only become assets after
 * `akm proposal accept` validates and promotes them via
 * {@link writeAssetToSource}.
 *
 * # Storage layout
 *
 *   <stashRoot>/.akm/proposals/<id>/proposal.json
 *   <stashRoot>/.akm/proposals/archive/<id>/proposal.json
 *
 * One directory per proposal id (a stable `crypto.randomUUID()`), so multiple
 * proposals can target the same `ref` without filesystem collisions.
 *
 * # Why direct fs (and not `writeAssetToSource`)
 *
 * The architectural rule "all writes go through `writeAssetToSource`" applies
 * to *assets*. Proposals are **not** assets — they live outside the asset tree
 * (under `.akm/proposals/`, parallel to how `events.jsonl` lives outside the
 * asset tree). Routing them through `writeAssetToSource` would force them into
 * a `TYPE_DIRS` slot, would commit them to git, and would leak unaccepted
 * drafts through the normal indexer. None of that is what we want for queue
 * state. The {@link promoteProposal} step is the bridge: it routes the
 * accepted payload through `writeAssetToSource` so the actual asset write
 * still funnels through the single dispatch point in
 * `src/core/write-source.ts`.
 *
 * Direct `fs` IO here is deliberate and the only place in the v1 codebase
 * that bypasses `writeAssetToSource` for "stash-adjacent" durable state. See
 * CLAUDE.md ("Writes" section) for the contract.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AssetRef } from "./asset-ref";
import { makeAssetRef, parseAssetRef } from "./asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "./asset-spec";
import type { AkmConfig } from "./config";
import { NotFoundError, UsageError } from "./errors";
import { parseFrontmatter } from "./frontmatter";
import { lintLessonContent } from "./lesson-lint";
import { resolveWriteTarget, type WriteTargetSource, writeAssetToSource } from "./write-source";

// ── Types ───────────────────────────────────────────────────────────────────

export type ProposalStatus = "pending" | "accepted" | "rejected";

export interface ProposalPayload {
  /** Full file content the accepted proposal will write to disk. */
  content: string;
  /** Convenience parsed frontmatter, if the content is markdown-with-frontmatter. */
  frontmatter?: Record<string, unknown>;
}

export interface ProposalReview {
  outcome: "accepted" | "rejected";
  reason?: string;
  decidedAt: string;
}

export interface Proposal {
  /** Stable random id (crypto.randomUUID()). Directory name on disk. */
  id: string;
  /** Asset ref the proposal would create or update (`[origin//]type:name`). */
  ref: string;
  status: ProposalStatus;
  /** Human-readable origin tag (e.g. "reflect", "distill", "remember"). */
  source: string;
  /** Optional run id (e.g. workflow run, reflect job) for traceability. */
  sourceRun?: string;
  createdAt: string;
  updatedAt: string;
  payload: ProposalPayload;
  review?: ProposalReview;
}

export interface ProposalsContext {
  /** Override the stash root used for proposal storage. */
  stashDir?: string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
}

export interface CreateProposalInput {
  ref: string;
  source: string;
  sourceRun?: string;
  payload: ProposalPayload;
}

// ── Path helpers ────────────────────────────────────────────────────────────

/**
 * Resolve `<stashRoot>/.akm/proposals` (or its archive subdirectory). Direct
 * fs paths because proposal storage is queue state, not asset state — see the
 * module docblock for the architectural carve-out.
 */
export function getProposalsRoot(stashDir: string, archive = false): string {
  return archive ? path.join(stashDir, ".akm", "proposals", "archive") : path.join(stashDir, ".akm", "proposals");
}

function proposalDir(stashDir: string, id: string, archive: boolean): string {
  return path.join(getProposalsRoot(stashDir, archive), id);
}

function proposalFile(stashDir: string, id: string, archive: boolean): string {
  return path.join(proposalDir(stashDir, id, archive), "proposal.json");
}

function nowIso(ctx?: ProposalsContext): string {
  const fn = ctx?.now ?? Date.now;
  return new Date(fn()).toISOString();
}

function newId(ctx?: ProposalsContext): string {
  const fn = ctx?.randomUUID ?? randomUUID;
  return fn();
}

// ── Read / write primitives ─────────────────────────────────────────────────

function readProposalFile(filePath: string): Proposal {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new NotFoundError(
      `Proposal not found at ${filePath}.`,
      "FILE_NOT_FOUND",
      `The proposal file is missing or unreadable: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `Proposal file at ${filePath} is not valid JSON: ${(err as Error).message}`,
      "INVALID_JSON_ARGUMENT",
      "Re-create the proposal or remove the corrupt file under .akm/proposals/<id>/.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new UsageError(`Proposal file at ${filePath} is not a JSON object.`, "INVALID_JSON_ARGUMENT");
  }
  return parsed as Proposal;
}

function writeProposalFile(filePath: string, proposal: Proposal): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new pending proposal. The id is a stable random UUID, so two
 * proposals with the same `ref` never collide on disk.
 */
export function createProposal(stashDir: string, input: CreateProposalInput, ctx?: ProposalsContext): Proposal {
  // Validate the ref up front so callers get a clear error instead of a
  // surprise during `accept`. This also normalises the ref string.
  const parsedRef = parseAssetRef(input.ref);
  const normalizedRef = makeAssetRef(parsedRef.type, parsedRef.name, parsedRef.origin);

  const id = newId(ctx);
  const created = nowIso(ctx);
  const proposal: Proposal = {
    id,
    ref: normalizedRef,
    status: "pending",
    source: input.source,
    ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
    createdAt: created,
    updatedAt: created,
    payload: {
      content: input.payload.content,
      ...(input.payload.frontmatter !== undefined ? { frontmatter: input.payload.frontmatter } : {}),
    },
  };

  writeProposalFile(proposalFile(stashDir, id, false), proposal);
  return proposal;
}

/**
 * List every proposal under the stash. By default returns pending proposals
 * from the live queue; pass `{ includeArchive: true }` to include rejected /
 * accepted entries that have been moved aside.
 */
export function listProposals(
  stashDir: string,
  options: { includeArchive?: boolean; status?: ProposalStatus; ref?: string } = {},
): Proposal[] {
  const out: Proposal[] = [];
  const roots: { dir: string; archive: boolean }[] = [{ dir: getProposalsRoot(stashDir, false), archive: false }];
  if (options.includeArchive) {
    roots.push({ dir: getProposalsRoot(stashDir, true), archive: true });
  }
  for (const { dir } of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip the archive subdirectory when iterating the live queue.
      if (!entry.isDirectory()) continue;
      if (entry.name === "archive") continue;
      const filePath = path.join(dir, entry.name, "proposal.json");
      if (!fs.existsSync(filePath)) continue;
      try {
        out.push(readProposalFile(filePath));
      } catch {
        // Surface invalid proposal files via a synthetic stub so callers can
        // see something in `akm proposal list` rather than the file
        // disappearing silently.
        out.push({
          id: entry.name,
          ref: "unknown:unknown",
          status: "pending",
          source: "invalid",
          createdAt: "",
          updatedAt: "",
          payload: { content: "" },
          review: {
            outcome: "rejected",
            reason: "Invalid proposal file (could not be parsed).",
            decidedAt: "",
          },
        });
      }
    }
  }
  return out
    .filter((p) => (options.status ? p.status === options.status : true))
    .filter((p) => (options.ref ? p.ref === options.ref : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Look up a proposal by id. Searches the live queue first, then the archive.
 * Throws `NotFoundError` when no match exists.
 */
export function getProposal(stashDir: string, id: string): Proposal {
  const livePath = proposalFile(stashDir, id, false);
  if (fs.existsSync(livePath)) return readProposalFile(livePath);
  const archivedPath = proposalFile(stashDir, id, true);
  if (fs.existsSync(archivedPath)) return readProposalFile(archivedPath);
  throw new NotFoundError(`Proposal "${id}" not found.`, "FILE_NOT_FOUND");
}

/**
 * Whether a proposal currently lives in the archive (used by callers that
 * need to know whether to look in the archive root for files / paths).
 */
export function isProposalArchived(stashDir: string, id: string): boolean {
  return !fs.existsSync(proposalFile(stashDir, id, false)) && fs.existsSync(proposalFile(stashDir, id, true));
}

/**
 * Move a proposal directory into the archive subtree and update its status.
 * Used by both accept (status `accepted`) and reject (status `rejected`)
 * paths so the live queue only contains pending entries.
 */
export function archiveProposal(
  stashDir: string,
  id: string,
  status: "accepted" | "rejected",
  reason: string | undefined,
  ctx?: ProposalsContext,
): Proposal {
  const sourceDir = proposalDir(stashDir, id, false);
  if (!fs.existsSync(sourceDir)) {
    // If it's already archived, just update the metadata in place.
    const archived = proposalFile(stashDir, id, true);
    if (fs.existsSync(archived)) {
      const existing = readProposalFile(archived);
      const updated: Proposal = {
        ...existing,
        status,
        updatedAt: nowIso(ctx),
        review: {
          outcome: status,
          ...(reason !== undefined ? { reason } : {}),
          decidedAt: nowIso(ctx),
        },
      };
      writeProposalFile(archived, updated);
      return updated;
    }
    throw new NotFoundError(`Proposal "${id}" not found.`, "FILE_NOT_FOUND");
  }

  const targetDir = proposalDir(stashDir, id, true);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.renameSync(sourceDir, targetDir);

  const updated: Proposal = {
    ...readProposalFile(proposalFile(stashDir, id, true)),
    status,
    updatedAt: nowIso(ctx),
    review: {
      outcome: status,
      ...(reason !== undefined ? { reason } : {}),
      decidedAt: nowIso(ctx),
    },
  };
  writeProposalFile(proposalFile(stashDir, id, true), updated);
  return updated;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ProposalValidationFinding {
  kind: string;
  message: string;
}

export interface ProposalValidationReport {
  ok: boolean;
  findings: ProposalValidationFinding[];
}

/**
 * Validate a proposal payload before promotion. Generic by default — any
 * proposal must parse cleanly and carry a non-empty body. Lessons get the
 * extra per-type lint from {@link lintLessonContent} so the contract documented
 * in v1 spec §13 is enforced at promotion time. Other asset types can hook
 * here in the future without changing call sites.
 */
export function validateProposal(proposal: Proposal): ProposalValidationReport {
  const findings: ProposalValidationFinding[] = [];

  if (!proposal.payload || typeof proposal.payload.content !== "string" || proposal.payload.content.trim() === "") {
    findings.push({ kind: "empty-content", message: `Proposal ${proposal.id} has empty content.` });
  }

  let ref: AssetRef;
  try {
    ref = parseAssetRef(proposal.ref);
  } catch (err) {
    findings.push({
      kind: "invalid-ref",
      message: `Proposal ${proposal.id} has invalid ref "${proposal.ref}": ${(err as Error).message}`,
    });
    return { ok: false, findings };
  }

  // Generic frontmatter parse check for markdown-y types. If the content
  // *looks* like it has frontmatter (`---\n…\n---`) we ensure it parses.
  if (proposal.payload.content.startsWith("---")) {
    try {
      parseFrontmatter(proposal.payload.content);
    } catch (err) {
      findings.push({
        kind: "invalid-frontmatter",
        message: `Proposal ${proposal.id} frontmatter could not be parsed: ${(err as Error).message}`,
      });
    }
  }

  // Type-specific validators.
  if (ref.type === "lesson") {
    const lessonReport = lintLessonContent(proposal.payload.content, `proposal:${proposal.id}`);
    for (const finding of lessonReport.findings) {
      findings.push({ kind: finding.kind, message: finding.message });
    }
  }

  return { ok: findings.length === 0, findings };
}

// ── Promotion ──────────────────────────────────────────────────────────────

export interface PromoteResult {
  proposal: Proposal;
  /** Where the asset was written. */
  assetPath: string;
  /** Normalised asset ref. */
  ref: string;
}

/**
 * Validate a proposal, then promote it through the canonical
 * {@link writeAssetToSource} dispatch (the single place that branches on
 * `source.kind`). On success the proposal directory is moved to the archive
 * with status `accepted`. Validation failures throw a `UsageError` carrying
 * every finding so the CLI can render a single clear error envelope.
 */
export async function promoteProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string } = {},
  ctx?: ProposalsContext,
): Promise<PromoteResult> {
  const proposal = getProposal(stashDir, id);
  if (proposal.status !== "pending") {
    throw new UsageError(
      `Proposal ${id} is not pending (current status: ${proposal.status}). Only pending proposals can be accepted.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const report = validateProposal(proposal);
  if (!report.ok) {
    const message = report.findings.map((f) => `[${f.kind}] ${f.message}`).join("\n");
    throw new UsageError(
      `Proposal ${id} failed validation:\n${message}`,
      "MISSING_REQUIRED_ARGUMENT",
      "Fix the proposal payload (frontmatter / content) and try again, or reject the proposal with a reason.",
    );
  }

  const ref = parseAssetRef(proposal.ref);
  if (!TYPE_DIRS[ref.type]) {
    throw new UsageError(`Proposal ${id} targets unknown asset type "${ref.type}".`, "INVALID_FLAG_VALUE");
  }

  const target = resolveWriteTarget(config, options.target);
  const written = await writeAssetToSource(target.source, target.config, ref, proposal.payload.content);

  const archived = archiveProposal(stashDir, id, "accepted", undefined, ctx);
  return { proposal: archived, assetPath: written.path, ref: written.ref };
}

// ── Diff helpers ────────────────────────────────────────────────────────────

export interface ProposalDiff {
  /** Existing asset content if one is currently materialised. */
  existing: string | null;
  /** Proposed content (always present). */
  proposed: string;
  /** Unified diff text — empty when `existing === proposed`. */
  unified: string;
  /** When true, no asset exists yet at the target ref. */
  isNew: boolean;
  /** Path the diff would write to (if accepted). */
  targetPath?: string;
}

/**
 * Compute a diff between a proposal payload and the existing on-disk asset.
 * Uses {@link resolveWriteTarget} to find where the asset would land — so the
 * diff matches exactly what `accept` will write. Falls back to "new asset"
 * when no asset is currently materialised at the target ref.
 */
export function diffProposal(
  stashDir: string,
  config: AkmConfig,
  id: string,
  options: { target?: string } = {},
): ProposalDiff {
  const proposal = getProposal(stashDir, id);
  const ref = parseAssetRef(proposal.ref);

  let targetPath: string | undefined;
  let existing: string | null = null;
  try {
    const target = resolveWriteTarget(config, options.target);
    targetPath = resolveAssetFilePathSafe(target.source, ref);
    if (targetPath && fs.existsSync(targetPath)) {
      existing = fs.readFileSync(targetPath, "utf8");
    }
  } catch {
    // No writable target configured — still return a "new asset" diff so
    // callers can see the proposed payload without erroring out.
  }

  const proposed = proposal.payload.content;
  if (existing === null) {
    return {
      existing: null,
      proposed,
      unified: formatNewAssetDiff(proposal.ref, proposed),
      isNew: true,
      ...(targetPath ? { targetPath } : {}),
    };
  }

  return {
    existing,
    proposed,
    unified: formatUnifiedDiff(existing, proposed, proposal.ref),
    isNew: false,
    ...(targetPath ? { targetPath } : {}),
  };
}

function resolveAssetFilePathSafe(source: WriteTargetSource, ref: AssetRef): string | undefined {
  const typeDir = TYPE_DIRS[ref.type];
  if (!typeDir) return undefined;
  const typeRoot = path.join(source.path, typeDir);
  try {
    return resolveAssetPathFromName(ref.type, typeRoot, ref.name);
  } catch {
    return undefined;
  }
}

/**
 * Minimal unified-diff renderer. We deliberately avoid pulling a runtime
 * dependency just for this — proposals diffs are usually small (a single
 * lesson / skill file), so the LCS-free greedy renderer below is plenty for
 * humans to review. The output mirrors `git diff --no-index` for the first
 * `@@ … @@` hunk: enough to be familiar, not so detailed that we re-implement
 * a full LCS table.
 */
export function formatUnifiedDiff(left: string, right: string, label: string): string {
  if (left === right) return "";
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const lines: string[] = [`--- ${label} (existing)`, `+++ ${label} (proposed)`];

  // Pad to the longer side so alignment is one-to-one. Real diff tools use
  // LCS to align matching runs; we don't need that fidelity for a review
  // surface — both halves are visible regardless.
  const max = Math.max(leftLines.length, rightLines.length);
  lines.push(`@@ 1,${leftLines.length} 1,${rightLines.length} @@`);
  for (let i = 0; i < max; i += 1) {
    const l = leftLines[i];
    const r = rightLines[i];
    if (l === r && l !== undefined) {
      lines.push(` ${l}`);
      continue;
    }
    if (l !== undefined) lines.push(`-${l}`);
    if (r !== undefined) lines.push(`+${r}`);
  }
  return lines.join("\n");
}

function formatNewAssetDiff(ref: string, content: string): string {
  const lines = [`--- /dev/null`, `+++ ${ref} (proposed, new asset)`];
  lines.push(`@@ 0,0 1,${content.split("\n").length} @@`);
  for (const line of content.split("\n")) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}
