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
import { type ChatMessage, chatCompletion, parseEmbeddedJsonResponse } from "../llm/client";
import { tryLlmFeature } from "../llm/feature-gate";
import { assembleAsset } from "./asset-serialize";
import type { AkmConfig, LlmConnectionConfig } from "./config";
import { getDefaultLlmConfig } from "./config";
import { parseFrontmatter } from "./frontmatter";

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
  return [
    "You are evaluating two derived memory entries to determine if they contain",
    "directly contradictory factual claims about the same subject.",
    "",
    "Memory A:",
    `Ref: ${a.ref}`,
    `Description: ${a.description || "(none)"}`,
    "Content:",
    "```",
    a.body.slice(0, BODY_TRUNCATION),
    "```",
    "",
    "Memory B:",
    `Ref: ${b.ref}`,
    `Description: ${b.description || "(none)"}`,
    "Content:",
    "```",
    b.body.slice(0, BODY_TRUNCATION),
    "```",
    "",
    "Answer ONLY with valid JSON — no prose, no code fences:",
    '{"contradicts": true|false, "reason": "<one sentence explaining why or why not>"}',
    "",
    "A contradiction means the memories make mutually exclusive factual claims about the",
    "same topic (e.g. Memory A says 'always use VPN' while Memory B says 'VPN is optional').",
    "If the memories are complementary, about different topics, or one supersedes the other",
    "without direct conflict, return false.",
  ].join("\n");
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
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);

  const existing: string[] = Array.isArray(parsed.data.contradictedBy) ? (parsed.data.contradictedBy as string[]) : [];
  if (existing.includes(contradictedByRef)) return false; // Edge already written.

  const updatedContradictedBy = [...new Set([...existing, contradictedByRef])].sort();
  const nextFrontmatter: Record<string, unknown> = {
    ...parsed.data,
    contradictedBy: updatedContradictedBy,
    beliefState: "contradicted",
  };

  fs.writeFileSync(filePath, assembleAsset(nextFrontmatter, parsed.content), "utf8");
  return true;
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
): Promise<ContradictionDetectionResult> {
  const result: ContradictionDetectionResult = {
    familiesExamined: 0,
    pairsChecked: 0,
    edgesWritten: 0,
    warnings: [],
  };

  const contradictionLlm = getDefaultLlmConfig(config);
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

        // Skip pairs where edges already exist in BOTH directions (no new information).
        const aRaw = fs.readFileSync(a.filePath, "utf8");
        const aParsed = parseFrontmatter(aRaw);
        const aCB: string[] = Array.isArray(aParsed.data.contradictedBy)
          ? (aParsed.data.contradictedBy as string[])
          : [];
        const bRaw = fs.readFileSync(b.filePath, "utf8");
        const bParsed = parseFrontmatter(bRaw);
        const bCB: string[] = Array.isArray(bParsed.data.contradictedBy)
          ? (bParsed.data.contradictedBy as string[])
          : [];
        if (aCB.includes(b.ref) && bCB.includes(a.ref)) continue;

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
        );

        totalPairsChecked++;
        result.pairsChecked++;

        if (!judgeResult) continue; // Feature gate disabled or LLM call failed.

        let parsed: { contradicts: boolean; reason?: string } | null | undefined = null;
        try {
          parsed = parseEmbeddedJsonResponse<{ contradicts: boolean; reason?: string }>(judgeResult);
        } catch {
          result.warnings.push(`Could not parse contradiction judge response for pair ${a.ref} / ${b.ref}`);
          continue;
        }

        if (!parsed?.contradicts) continue;

        // Write contradiction edges: both members get contradictedBy pointing to each other.
        try {
          const wroteA = writeContradictedByEdge(a.filePath, b.ref);
          const wroteB = writeContradictedByEdge(b.filePath, a.ref);
          result.edgesWritten += (wroteA ? 1 : 0) + (wroteB ? 1 : 0);
        } catch (err) {
          result.warnings.push(
            `Failed to write contradiction edge ${a.ref} <-> ${b.ref}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (totalPairsChecked >= MAX_PAIRS_PER_RUN) break;
    }
  }

  return result;
}
