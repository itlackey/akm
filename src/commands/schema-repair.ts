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
import { stringify as yamlStringify } from "yaml";
import { parseAssetRef } from "../core/asset-ref";
import type { LlmConnectionConfig } from "../core/config";
import { appendEvent, readEvents } from "../core/events";
import { parseFrontmatter } from "../core/frontmatter";
import { info } from "../core/warn";
import { resolveAssetPath } from "../indexer/path-resolver";
import { chatCompletion, parseEmbeddedJsonResponse } from "../llm/client";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SchemaRepairFailure {
  ref: string;
  reason: string;
}

export type SchemaRepairOutcome = "written" | "skipped" | "error";

export interface SchemaRepairRecord {
  ref: string;
  reason: string;
  outcome: SchemaRepairOutcome;
  error?: string;
}

export interface SchemaRepairOptions {
  /** Milliseconds since epoch when the surrounding improve run started (for budget checks). */
  startMs: number;
  /** Budget deadline in ms since epoch. */
  budgetMs: number;
  /** LLM config to use for repair calls. */
  llmConfig: LlmConnectionConfig;
  /** Optional stash directory for asset resolution. */
  stashDir?: string;
  /** Override the asset file-path resolver (test seam). */
  findFilePath?: (ref: string, stashDir?: string) => Promise<string | null> | string | null;
  /** Whether a given ref is a lesson candidate (affects which fields to repair). */
  isLessonCandidateFn?: (ref: string) => boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum gap between schema-repair attempts on the same asset. */
const SCHEMA_REPAIR_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

    const filePath = await findFilePath(failure.ref, stashDir);
    if (!filePath) {
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
      const llmResponse = await chatCompletion(llmConfig, [
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
      const fmStr = yamlStringify(newFm).trimEnd();
      const newContent = `---\n${fmStr}\n---\n${fm.content}`;
      fs.writeFileSync(filePath, newContent, "utf8");
      info(`[improve] schema-repair written: ${failure.ref}`);
      appendEvent({
        eventType: "schema_repair_invoked",
        ref: failure.ref,
        metadata: { outcome: "written", reason: failure.reason },
      });
      repairs.push({ ref: failure.ref, reason: failure.reason, outcome: "written" });
      repairedRefs.add(failure.ref);
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
