// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Schema-repair pass for `akm improve`.
 *
 * Attempts to patch missing frontmatter fields (`description`, `when_to_use`)
 * on assets that failed schema validation, using a single bounded in-tree LLM
 * call per asset. Results are recorded as `schema_repair_invoked` events.
 *
 * This module is extracted from `improve.ts` to make the repair logic
 * independently testable and to use the `tryLlmFeature` seam rather than raw
 * `chatCompletion`.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../../core/asset-ref";
import { assembleAsset } from "../../core/asset-serialize";
import type { LlmConnectionConfig } from "../../core/config";
import { appendEvent, readEvents } from "../../core/events";
import { parseFrontmatter } from "../../core/frontmatter";
import { createProposal, isProposalSkipped } from "../../core/proposals";
import { info, warn } from "../../core/warn";
import { resolveAssetPath } from "../../indexer/path-resolver";
import { chatCompletion, parseEmbeddedJsonResponse } from "../../llm/client";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SchemaRepairFailure {
  ref: string;
  reason: string;
}

/**
 * Schema-repair outcome values (M-3 / #387).
 *
 *   - `queued`  — LLM generated fields were written to the proposal queue
 *                 (replaces the previous `written` path which wrote directly
 *                 to disk, bypassing the proposal queue safety invariant).
 *   - `written` — Legacy / direct-write path (retained for backward compat;
 *                 no longer emitted by the default implementation).
 *   - `skipped` — Asset didn't need repair or was on cooldown.
 *   - `error`   — LLM call failed or JSON could not be parsed.
 */
export type SchemaRepairOutcome = "queued" | "written" | "skipped" | "error";

export interface SchemaRepairRecord {
  ref: string;
  reason: string;
  outcome: SchemaRepairOutcome;
  /** Proposal id when outcome is "queued". */
  proposalId?: string;
  error?: string;
}

export interface SchemaRepairOptions {
  /** Milliseconds since epoch when the surrounding improve run started (for budget checks). */
  startMs: number;
  /** Budget deadline in ms since epoch. */
  budgetMs: number;
  /** LLM config to use for repair calls. */
  llmConfig: LlmConnectionConfig;
  /** Optional stash directory for proposal queue writes (M-3 / #387). When absent, falls back to direct write. */
  stashDir?: string;
  /** Override the asset file-path resolver (test seam). */
  findFilePath?: (ref: string, stashDir?: string) => Promise<string | null> | string | null;
  /** Whether a given ref is a lesson candidate (affects which fields to repair). */
  isLessonCandidateFn?: (ref: string) => boolean;
  /** Override the LLM chat function (test seam). Defaults to {@link chatCompletion}. */
  chatFn?: (llmConfig: LlmConnectionConfig, messages: Array<{ role: string; content: string }>) => Promise<string>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum gap between schema-repair attempts on the same asset. */
const SCHEMA_REPAIR_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Per-ref attempt cap (O-6 / #379): maximum number of schema-repair attempts
 * allowed within SCHEMA_REPAIR_WINDOW_MS. Prevents indefinite nightly re-repair
 * of assets whose source content is genuinely ambiguous or inconsistently
 * structured. After cap, the asset is skipped until the window rolls over.
 * Self-Refine arXiv:2303.17651 — iteration must be bounded.
 */
const SCHEMA_REPAIR_MAX_ATTEMPTS = 3;
const SCHEMA_REPAIR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Run the schema-repair loop for a batch of validation failures.
 * Returns a list of per-asset outcome records and the set of refs that were
 * successfully repaired (so the caller can exclude them from skip logic).
 */
export async function runSchemaRepairPass(
  failures: SchemaRepairFailure[],
  options: SchemaRepairOptions,
): Promise<{ repairs: SchemaRepairRecord[]; repairedRefs: Set<string> }> {
  const repairs: SchemaRepairRecord[] = [];
  const repairedRefs = new Set<string>();

  const {
    startMs,
    budgetMs,
    llmConfig,
    stashDir,
    findFilePath = defaultFindFilePath,
    isLessonCandidateFn = defaultIsLessonCandidate,
    chatFn = chatCompletion,
  } = options;

  for (const failure of failures) {
    if (Date.now() - startMs >= budgetMs) break;

    // Cooldown: skip repair if we ran it successfully recently.
    const recentRepairs = readEvents({ type: "schema_repair_invoked", ref: failure.ref });
    const lastRepair = recentRepairs.events
      .filter((e) => e.metadata?.outcome === "written")
      .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())[0];
    if (lastRepair?.ts && Date.now() - new Date(lastRepair.ts).getTime() < SCHEMA_REPAIR_COOLDOWN_MS) {
      repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
      continue;
    }

    // O-6 / #379: Cap total attempts at SCHEMA_REPAIR_MAX_ATTEMPTS per SCHEMA_REPAIR_WINDOW_MS.
    // Prevents indefinite nightly re-repair of assets whose source is genuinely ambiguous.
    // After the cap is reached, the asset is skipped until the window rolls over.
    const windowStart = Date.now() - SCHEMA_REPAIR_WINDOW_MS;
    const attemptsInWindow = recentRepairs.events.filter(
      (e) => e.ts !== undefined && new Date(e.ts).getTime() >= windowStart,
    ).length;
    if (attemptsInWindow >= SCHEMA_REPAIR_MAX_ATTEMPTS) {
      repairs.push({
        ref: failure.ref,
        reason: failure.reason,
        outcome: "skipped",
        error: `schema-repair attempt cap reached (${attemptsInWindow}/${SCHEMA_REPAIR_MAX_ATTEMPTS} in 30d window)`,
      });
      continue;
    }

    const filePath = await findFilePath(failure.ref, stashDir);
    if (!filePath) {
      repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
      continue;
    }

    if (path.extname(filePath).toLowerCase() !== ".md") {
      repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
      continue;
    }

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const fm = parseFrontmatter(raw);

      const missingFields: string[] = [];
      if (!fm.data.description) missingFields.push("description");
      if (isLessonCandidateFn(failure.ref) && !fm.data.when_to_use) missingFields.push("when_to_use");

      if (missingFields.length === 0) {
        repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
        continue;
      }

      const fieldList = missingFields.join(" and ");
      info(`[improve] schema-repair ${failure.ref} (${fieldList})`);

      const bodyPreview = (fm.content ?? raw).slice(0, 2000);
      const llmResponse = await chatFn(llmConfig, [
        {
          role: "system",
          content: `You generate concise asset frontmatter fields. Respond with a JSON object containing only the missing fields. No prose, no markdown fences.`,
        },
        {
          role: "user",
          content: `Generate the missing frontmatter fields (${fieldList}) for this ${parseAssetRef(failure.ref).type} asset. Return ONLY valid JSON like {"description": "...", "when_to_use": "..."}\n\n${bodyPreview}`,
        },
      ]);

      const parsed = parseEmbeddedJsonResponse<Record<string, string>>(llmResponse.trim());
      if (!parsed) {
        repairs.push({
          ref: failure.ref,
          reason: failure.reason,
          outcome: "error",
          error: "LLM returned unparseable JSON for schema repair",
        });
        continue;
      }

      const newFm = { ...fm.data };
      if (parsed.description) newFm.description = parsed.description;
      if (parsed.when_to_use) newFm.when_to_use = parsed.when_to_use;
      const newContent = assembleAsset(newFm, fm.content);

      // M-3 / #387: Route through proposal queue instead of writing directly to
      // disk. This restores akm's safety invariant — the proposal queue is the
      // only path to a committed asset write. LLM-generated `description` /
      // `when_to_use` fields can be incorrect; routing through the queue makes
      // them human-reviewable before they affect search ranking and curate hints.
      // mem0 open gaps (arXiv:2504.19413) — any LLM write to a memory field
      // should be human-reviewable.
      if (stashDir) {
        const proposalResult = createProposal(stashDir, {
          ref: failure.ref,
          source: "schema-repair",
          payload: {
            content: newContent,
            ...(Object.keys(newFm).length > 0 ? { frontmatter: newFm } : {}),
          },
        });

        if (isProposalSkipped(proposalResult)) {
          info(`[improve] schema-repair proposal skipped for ${failure.ref}: ${proposalResult.message}`);
          repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "skipped" });
          continue;
        }

        info(`[improve] schema-repair queued: ${failure.ref} (proposal id: ${proposalResult.id})`);
        appendEvent({
          eventType: "schema_repair_invoked",
          ref: failure.ref,
          metadata: { outcome: "queued", reason: failure.reason, proposalId: proposalResult.id },
        });
        repairs.push({
          ref: failure.ref,
          reason: failure.reason,
          outcome: "queued",
          proposalId: proposalResult.id,
        });
        // Mark as repaired so the caller removes it from the validation-failure set.
        repairedRefs.add(failure.ref);
      } else {
        // Fallback: no stash dir available — write directly (legacy path).
        // This should not occur in production; stashDir is always provided by
        // `runSchemaRepairPass` callers in improve.ts.
        warn(`[improve] schema-repair: no stashDir available for ${failure.ref}, falling back to direct write`);
        fs.writeFileSync(filePath, newContent, "utf8");
        info(`[improve] schema-repair written: ${failure.ref}`);
        appendEvent({
          eventType: "schema_repair_invoked",
          ref: failure.ref,
          metadata: { outcome: "written", reason: failure.reason },
        });
        repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "written" });
        repairedRefs.add(failure.ref);
      }
    } catch (e) {
      appendEvent({
        eventType: "schema_repair_invoked",
        ref: failure.ref,
        metadata: { outcome: "error", reason: failure.reason, error: String(e) },
      });
      repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "error", error: String(e) });
    }
  }

  return { repairs, repairedRefs };
}

// ── Default seam implementations ─────────────────────────────────────────────

function defaultIsLessonCandidate(ref: string): boolean {
  try {
    const parsed = parseAssetRef(ref);
    return parsed.type === "lesson";
  } catch {
    return false;
  }
}

async function defaultFindFilePath(ref: string, stashDir?: string): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "index-first",
    directoryIndexNames: ["SKILL.md", "index.md", "README.md"],
    preserveDirectNameFallback: true,
  });
}
