// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * LLM-based contradiction-detection pass for derived memories (M-1 / #367).
 *
 * Runs BEFORE `analyzeMemoryCleanup` to populate `contradictedBy` frontmatter
 * edges so the existing `resolveFamilyContradictions` SCC resolver has real
 * input to work on. Without this pass the SCC resolver operates on a nearly
 * empty edge graph because no automated subsystem was previously generating
 * contradiction edges — the elegant Tarjan implementation in memory-improve.ts
 * had no input.
 *
 * # Algorithm
 *
 *   1. Collect all derived memories grouped by `parentRef` family.
 *   2. For each family, enumerate candidate pairs (limited to MAX_FAMILY_SIZE).
 *   3. For each pair, call the LLM to judge whether the two memories are in
 *      direct factual conflict.
 *   4. For confirmed contradictions, write `contradictedBy` edges directly to
 *      the losing memory's frontmatter (same mechanism as `persistBeliefStateTransition`).
 *
 * # LLM Feature Gate
 *
 * The pass is gated behind `profiles.improve.default.processes.consolidate.contradictionDetection.enabled`.
 * When the gate is disabled or no LLM is configured,
 * the pass is a no-op and `analyzeMemoryCleanup` proceeds with only manually
 * annotated edges.
 *
 * # References
 *
 * - Zep / Graphiti (arXiv:2501.13956): writes contradiction edges at detection time.
 * - ATMS (de Kleer 1986): assumption-based truth maintenance via edge propagation.
 * - mem0 contradiction probe (arXiv:2504.19413): pairwise LLM-judge pattern.
 */

import fs from "node:fs";
import path from "node:path";
import contradictionJudgeTemplate from "../../../assets/prompts/contradiction-judge.md" with { type: "text" };
import { mutateFrontmatter, parseFrontmatter } from "../../../core/asset/frontmatter";
import type { AkmConfig, LlmConnectionConfig } from "../../../core/config/config";
import { getDefaultLlmConfig, type ImproveProfileConfig } from "../../../core/config/config";
import { resolveImproveProcessRunner } from "../../../integrations/agent/runner";
import { type ChatMessage, chatCompletion, parseEmbeddedJsonResponse } from "../../../llm/client";
import { tryLlmFeature } from "../../../llm/feature-gate";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum family size for pairwise contradiction checking. Families larger
 * than this are skipped to bound the LLM call count (O(n²) pairs).
 */
const MAX_FAMILY_SIZE = 8;

/**
 * Maximum number of contradiction pairs to check per improve run, across all
 * families. Prevents runaway LLM usage on stashes with many memories.
 */
const MAX_PAIRS_PER_RUN = 20;

/**
 * Minimum confidence required to write a contradiction edge. Below this
 * threshold the LLM may be flagging topic-overlap rather than genuine logical
 * exclusivity (investigation 2026-06-18). Absent confidence fields default to
 * 1.0 for backward compatibility with older judge responses.
 */
const CONTRADICT_CONFIDENCE_THRESHOLD = 0.92;

/**
 * Truncation limit for memory body content sent to the LLM judge.
 * Keeps prompts compact while preserving the key factual claims.
 */
const BODY_TRUNCATION = 800;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContradictionDetectionResult {
  /** Number of derived memory families examined. */
  familiesExamined: number;
  /** Number of pairwise LLM contradiction checks performed. */
  pairsChecked: number;
  /** Number of contradiction edges written to frontmatter. */
  edgesWritten: number;
  /** Warnings generated during detection (e.g. LLM failures, parse errors). */
  warnings: string[];
}

interface DerivedMemoryEntry {
  filePath: string;
  ref: string;
  parentRef: string;
  body: string;
  description: string;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildContradictionJudgePrompt(a: DerivedMemoryEntry, b: DerivedMemoryEntry): string {
  return contradictionJudgeTemplate
    .replace("{{A_REF}}", a.ref)
    .replace("{{A_DESCRIPTION}}", a.description || "(none)")
    .replace("{{A_BODY}}", a.body.slice(0, BODY_TRUNCATION))
    .replace("{{B_REF}}", b.ref)
    .replace("{{B_DESCRIPTION}}", b.description || "(none)")
    .replace("{{B_BODY}}", b.body.slice(0, BODY_TRUNCATION));
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

function* walkMarkdownFilesLocal(root: string): Generator<string> {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkMarkdownFilesLocal(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) yield full;
  }
}

function toMemoryRef(memoriesDir: string, filePath: string): string | undefined {
  const rel = path.relative(memoriesDir, filePath);
  if (!rel || rel.startsWith("..")) return undefined;
  const name = rel.replace(/\\/g, "/").replace(/\.md$/i, "");
  return `memory:${name}`;
}

function isDerivedMemory(filePath: string, frontmatter: Record<string, unknown>): boolean {
  // Name-based guard (M-2): the .derived suffix is structural and immutable.
  const base = path.basename(filePath, ".md");
  if (base.endsWith(".derived")) return true;
  // Frontmatter-based guard: inferred: true marks explicit child memories.
  return frontmatter.inferred === true;
}

function resolveParentRef(
  filePath: string,
  frontmatter: Record<string, unknown>,
  memoriesRootDir?: string,
): string | undefined {
  // Prefer the explicit source: frontmatter.
  const source = frontmatter.source;
  if (typeof source === "string" && source.startsWith("memory:")) return source;
  // Fall back to deriving parent from the file name (strip .derived suffix).
  const base = path.basename(filePath, ".md");
  if (base.endsWith(".derived")) {
    const parentName = base.slice(0, -".derived".length);
    // Use the stash memories root so nested paths (e.g. memories/nested/foo.derived.md)
    // resolve to the correct relative ref (memory:nested/foo, not memory:foo).
    const rootDir = memoriesRootDir ?? path.dirname(filePath);
    const rel = path.relative(rootDir, path.join(path.dirname(filePath), parentName));
    return `memory:${rel.replace(/\\/g, "/")}`;
  }
  return undefined;
}

// ── Edge writing ─────────────────────────────────────────────────────────────

/**
 * Write a `contradictedBy` edge to the losing memory's frontmatter file.
 * Preserves all existing frontmatter keys; only adds/updates `contradictedBy`
 * and `beliefState: contradicted`.
 */
/** Returns true if the edge was newly written, false if it already existed. */
function writeContradictedByEdge(filePath: string, contradictedByRef: string): boolean {
  return mutateFrontmatter(filePath, (parsed) => {
    const existing: string[] = Array.isArray(parsed.data.contradictedBy)
      ? (parsed.data.contradictedBy as string[])
      : [];
    if (existing.includes(contradictedByRef)) return null; // Edge already written.

    const updatedContradictedBy = [...new Set([...existing, contradictedByRef])].sort();
    return {
      ...parsed.data,
      contradictedBy: updatedContradictedBy,
      beliefState: "contradicted",
    };
  });
}

/**
 * Deterministically pick, for a confirmed-contradiction pair, the LOSER memory
 * that receives the single directed `contradictedBy` edge (SCC-resolved to
 * `contradicted`) and the WINNER ref that survives as the current belief.
 *
 * A SINGLE directed edge is essential. Writing mutual A↔B edges forms a 2-cycle
 * that {@link resolveFamilyContradictions} collapses into one strongly-connected
 * SINK component and refreshes BOTH members back to active — erasing the
 * contradiction on every run (the self-erasing bug this fix removes).
 *
 * Direction = lexicographic ref order: the ref that sorts LATER is the loser.
 * This is a **total order** over the family's (distinct) refs, so the induced
 * edges are always acyclic — a family of any size resolves to a DAG with a
 * single sink, never a cycle that the resolver would refresh back to active.
 * It is also immutable across runs (unlike file mtime, which the resolver
 * bumps when it rewrites loser files), so detection is idempotent. Ref order
 * carries no recency meaning — no derived-memory writer sets a `createdAt`/
 * timestamp today — but the mechanism only needs a stable, acyclic direction;
 * eliminating worst-case self-erasure, not ranking by recency, is the goal.
 */
function pickContradictionLoser(
  a: DerivedMemoryEntry,
  b: DerivedMemoryEntry,
): { loser: DerivedMemoryEntry; winnerRef: string } {
  return a.ref < b.ref ? { loser: b, winnerRef: a.ref } : { loser: a, winnerRef: b.ref };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the LLM-based contradiction-detection pass on derived memories in
 * `<stashDir>/memories/`. Writes `contradictedBy` frontmatter edges for
 * confirmed contradiction pairs so the subsequent `resolveFamilyContradictions`
 * SCC pass has edges to work on.
 *
 * @param stashDir - Root stash directory.
 * @param config   - Loaded AKM config (used to access LLM settings).
 * @param chat     - Optional chat seam for testing (defaults to chatCompletion).
 */
export async function detectAndWriteContradictions(
  stashDir: string,
  config: AkmConfig,
  chat: (llmConfig: LlmConnectionConfig, messages: ChatMessage[]) => Promise<string> = chatCompletion,
  strategy?: ImproveProfileConfig,
): Promise<ContradictionDetectionResult> {
  const result: ContradictionDetectionResult = {
    familiesExamined: 0,
    pairsChecked: 0,
    edgesWritten: 0,
    warnings: [],
  };

  const contradictionLlm =
    resolveImproveProcessRunner(strategy, "consolidate", config)?.connection ?? getDefaultLlmConfig(config);
  if (!contradictionLlm) return result;

  // Collect derived memories grouped by parent.
  const memoriesDir = path.join(stashDir, "memories");
  const byParent = new Map<string, DerivedMemoryEntry[]>();

  for (const filePath of walkMarkdownFilesLocal(memoriesDir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!isDerivedMemory(filePath, parsed.data)) continue;
    const parentRef = resolveParentRef(filePath, parsed.data, memoriesDir);
    if (!parentRef) continue;
    const ref = toMemoryRef(memoriesDir, filePath);
    if (!ref) continue;

    const entry: DerivedMemoryEntry = {
      filePath,
      ref,
      parentRef,
      body: parsed.content.trim(),
      description: typeof parsed.data.description === "string" ? parsed.data.description : "",
    };
    const family = byParent.get(parentRef) ?? [];
    family.push(entry);
    byParent.set(parentRef, family);
  }

  let totalPairsChecked = 0;

  for (const [, family] of byParent) {
    if (family.length < 2) continue;
    if (family.length > MAX_FAMILY_SIZE) {
      result.warnings.push(
        `Skipping contradiction check for family of ${family.length} members (exceeds MAX_FAMILY_SIZE=${MAX_FAMILY_SIZE})`,
      );
      continue;
    }

    result.familiesExamined++;

    for (let i = 0; i < family.length - 1; i++) {
      for (let j = i + 1; j < family.length; j++) {
        if (totalPairsChecked >= MAX_PAIRS_PER_RUN) break;

        const a = family[i];
        const b = family[j];
        if (!a || !b) continue;

        // Resolve the directed edge up front (independent of the judge — it is
        // decided by lexicographic ref order). Skip when that single loser→winner
        // edge already exists (no new information; avoids re-judging resolved
        // pairs across runs).
        //
        // Legacy mutual A↔B edges written by the pre-fix pass self-heal: the
        // skip fires this run, but the SCC resolver treats the 2-cycle as a sink
        // and refreshes both to active — DELETING both `contradictedBy` arrays
        // (memory-improve.ts persistBeliefStateTransition). The next detection
        // run then sees no edge, re-judges, and writes the single canonical edge.
        const aParsed = parseFrontmatter(fs.readFileSync(a.filePath, "utf8"));
        const bParsed = parseFrontmatter(fs.readFileSync(b.filePath, "utf8"));
        const { loser, winnerRef } = pickContradictionLoser(a, b);
        const loserData = loser === a ? aParsed.data : bParsed.data;
        const loserCB: string[] = Array.isArray(loserData.contradictedBy) ? (loserData.contradictedBy as string[]) : [];
        if (loserCB.includes(winnerRef)) continue;

        const prompt = buildContradictionJudgePrompt(a, b);
        const judgeResult = await tryLlmFeature(
          "memory_contradiction_detection",
          config,
          async () => {
            return chat(contradictionLlm, [
              { role: "system", content: "Return only valid JSON. No prose." },
              { role: "user", content: prompt },
            ]);
          },
          null, // Fallback: null means "skip" — gate disabled or LLM call failed.
          { strategy },
        );

        totalPairsChecked++;
        result.pairsChecked++;

        if (!judgeResult) continue; // Feature gate disabled or LLM call failed.

        let parsed: { contradicts: boolean; confidence?: number; reason?: string } | null | undefined = null;
        try {
          parsed = parseEmbeddedJsonResponse<{ contradicts: boolean; confidence?: number; reason?: string }>(
            judgeResult,
          );
        } catch {
          result.warnings.push(`Could not parse contradiction judge response for pair ${a.ref} / ${b.ref}`);
          continue;
        }

        if (!parsed?.contradicts) continue;

        // Confidence gate: absent field defaults to 1.0 (backward compat with
        // pre-confidence responses). Do NOT default to 0 — that would silently
        // disable all detection during the rollout period.
        const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 1.0;
        if (confidence < CONTRADICT_CONFIDENCE_THRESHOLD) {
          result.warnings.push(
            `Pair ${a.ref} / ${b.ref}: confidence ${confidence.toFixed(2)} below ${CONTRADICT_CONFIDENCE_THRESHOLD} threshold — skipped.`,
          );
          continue;
        }

        // Write a SINGLE directed contradiction edge: the losing (older) memory
        // gets `contradictedBy` pointing to the winner. A mutual A↔B pair forms
        // a 2-cycle that the SCC resolver refreshes back to active, erasing the
        // contradiction every run (see pickContradictionLoser).
        try {
          const wrote = writeContradictedByEdge(loser.filePath, winnerRef);
          result.edgesWritten += wrote ? 1 : 0;
        } catch (err) {
          result.warnings.push(
            `Failed to write contradiction edge ${loser.ref} -> ${winnerRef}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (totalPairsChecked >= MAX_PAIRS_PER_RUN) break;
    }
  }

  return result;
}
