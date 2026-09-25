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
 *   2. For each family, enumerate candidate pairs.
 *   3. For each pair, call the LLM to judge whether the two memories are in
 *      direct factual conflict.
 *   4. For confirmed contradictions, append a `contradictedBy` edge to the
 *      losing memory's frontmatter via `writeContradictEdge`
 *      (`./memory-belief.ts`).
 *
 * That last step used to call a private near-copy of `writeContradictEdge`
 * living in this file. The copy had drifted (#885): it read `contradictedBy`
 * with `Array.isArray` only, so a SCALAR edge — live data the indexer accepts
 * and lint never flags — read as "no edges" and was overwritten out of
 * existence; and it set `beliefState: "contradicted"` unconditionally,
 * promoting an `archived` memory back up (archived ranks BELOW contradicted).
 * Both behaviors had tests, but the tests exercised the shared primitive,
 * which nothing called — so they guarded dead code while the live path
 * carried the bugs.
 *
 * # LLM Feature Gate
 *
 * The pass is gated by the selected strategy's consolidate contradiction setting.
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
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import type { AkmConfig, ImproveProfileConfig } from "../../../core/config/config";
import { parseEmbeddedJsonResponse } from "../../../core/parse";
import type { LoweringNotice } from "../../../execution/resolved-request";
import type { RunnerSpec } from "../../../integrations/agent/runner";
import { assertRunnerCredentials } from "../../../integrations/agent/runner-dispatch";
import type { chatCompletion } from "../../../llm/client";
import { callStructured } from "../../../llm/structured-call";
import { resolveImproveLlmExecution } from "../execution";
import { isDerivedMemory, memoryIdentityRef, resolveParentRef } from "./derived-ref";
import { writeContradictEdge } from "./memory-belief";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum confidence required to write a contradiction edge. Below this
 * threshold the LLM may be flagging topic-overlap rather than genuine logical
 * exclusivity (investigation 2026-06-18).
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
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
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

// Build the derived memory's own belief-edge IDENTITY ref from its file path.
// Emits through the shared {@link memoryIdentityRef} so this — the former THIRD
// hand-rolled copy of the identity-channel spelling — no longer diverges from
// memory-improve's `refArray` (ref-grammar decision D-R3 identity-channel
// exception, documented at `memoryIdentityRef`).
function toMemoryRef(memoriesDir: string, filePath: string): string | undefined {
  const rel = path.relative(memoriesDir, filePath);
  if (!rel || rel.startsWith("..")) return undefined;
  const name = rel.replace(/\\/g, "/").replace(/\.md$/i, "");
  return memoryIdentityRef(name);
}

// ── Edge writing ─────────────────────────────────────────────────────────────

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
 * @param chat     - Optional test-only chat seam.
 */
export async function detectAndWriteContradictions(
  stashDir: string,
  config: AkmConfig,
  chat?: typeof chatCompletion,
  strategy?: ImproveProfileConfig,
  resolvedRunner?: Extract<RunnerSpec, { kind: "llm" }> | null,
): Promise<ContradictionDetectionResult> {
  const result: ContradictionDetectionResult = {
    familiesExamined: 0,
    pairsChecked: 0,
    edgesWritten: 0,
    warnings: [],
  };
  if (!(strategy?.processes?.consolidate?.contradictionDetection?.enabled ?? false)) return result;

  const noticesByKey = new Map<string, Readonly<LoweringNotice>>();
  const resolvedExecution =
    resolvedRunner === undefined
      ? resolveImproveLlmExecution({
          config,
          profile: strategy,
          process: strategy?.processes?.consolidate,
          processName: "memory-contradiction-detection",
        })
      : null;
  for (const notice of resolvedExecution?.notices ?? []) noticesByKey.set(JSON.stringify(notice), notice);

  const contradictionRunner = resolvedRunner === null ? undefined : (resolvedRunner ?? resolvedExecution?.runner);
  if (!contradictionRunner) return result;

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
    const ref = toMemoryRef(memoriesDir, filePath);
    if (!ref) continue;
    // Key the shared derived-ref helpers on the memory NAME (stash-relative, no
    // extension) — the same key the consumer uses — so producer and consumer
    // resolve the identical parent (R12). This intentionally widens the producer
    // to honour `derivedFrom` and normalised `source:` values it previously
    // dropped (pinned by derived-ref.test.ts).
    const name = ref.slice("memory:".length);
    if (!isDerivedMemory(name, parsed.data)) continue;
    const parentRef = resolveParentRef(name, parsed.data);
    if (!parentRef) continue;

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

  const candidatePairs: Array<{
    a: DerivedMemoryEntry;
    b: DerivedMemoryEntry;
    loser: DerivedMemoryEntry;
    winnerRef: string;
  }> = [];

  for (const [, family] of byParent) {
    if (family.length < 2) continue;

    result.familiesExamined++;

    for (let i = 0; i < family.length - 1; i++) {
      for (let j = i + 1; j < family.length; j++) {
        const a = family[i];
        const b = family[j];
        if (!a || !b) continue;

        // Resolve the directed edge up front (independent of the judge — it is
        // decided by lexicographic ref order). Skip when that single loser→winner
        // edge already exists (no new information; avoids re-judging resolved
        // pairs across runs).
        //
        const aParsed = parseFrontmatter(fs.readFileSync(a.filePath, "utf8"));
        const bParsed = parseFrontmatter(fs.readFileSync(b.filePath, "utf8"));
        const { loser, winnerRef } = pickContradictionLoser(a, b);
        const loserData = loser === a ? aParsed.data : bParsed.data;
        const loserCB: string[] = Array.isArray(loserData.contradictedBy) ? (loserData.contradictedBy as string[]) : [];
        if (loserCB.includes(winnerRef)) continue;

        candidatePairs.push({ a, b, loser, winnerRef });
      }
    }
  }

  if (candidatePairs.length === 0) {
    const notices = Object.freeze([...noticesByKey.values()]);
    return notices.length > 0 ? { ...result, notices } : result;
  }

  assertRunnerCredentials(contradictionRunner);
  for (const { a, b, loser, winnerRef } of candidatePairs) {
    const prompt = buildContradictionJudgePrompt(a, b);
    const judgeResult = await callStructured<string | null>({
      feature: "memory_contradiction_detection",
      akmConfig: config,
      // Resolver-less key: the strategy decision IS the gate (default-off).
      enabled: true,
      runner: contradictionRunner,
      messages: [
        { role: "system", content: "Return only valid JSON. No prose." },
        { role: "user", content: prompt },
      ],
      ...(chat ? { request: { chat } } : {}),
      onNotices: (notices) => {
        for (const notice of notices) noticesByKey.set(JSON.stringify(notice), notice);
      },
      parse: (raw) => raw ?? null,
      // A transport throw used to escape the gated fn into the gate's
      // catch and take the null fallback ("skip"); onError reproduces it.
      onError: () => null,
      fallback: null, // null means "skip" — gate disabled or LLM call failed.
    });

    result.pairsChecked++;

    if (!judgeResult) continue; // Feature gate disabled or LLM call failed.

    let parsed: { contradicts: boolean; confidence: number; reason?: string } | null | undefined = null;
    try {
      parsed = parseEmbeddedJsonResponse<{ contradicts: boolean; confidence: number; reason?: string }>(judgeResult);
    } catch {
      result.warnings.push(`Could not parse contradiction judge response for pair ${a.ref} / ${b.ref}`);
      continue;
    }

    if (!parsed?.contradicts) continue;

    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
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
      const wrote = writeContradictEdge(loser.filePath, winnerRef);
      result.edgesWritten += wrote ? 1 : 0;
    } catch (err) {
      result.warnings.push(
        `Failed to write contradiction edge ${loser.ref} -> ${winnerRef}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const notices = Object.freeze([...noticesByKey.values()]);
  return notices.length > 0 ? { ...result, notices } : result;
}
