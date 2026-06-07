// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Staleness-detection pass for `akm improve` (Phase 4A,
 * `.plans/0.8.0/self-improvement-enhancements-plan.md` lines 132-145).
 *
 * Activates the `deprecated` belief-state machinery shipped in Phase 1A
 * (commit 7b6fffe). Without this pass, nothing in the pipeline ever wrote
 * `beliefState: deprecated`, so the -0.15 ranking penalty and the
 * `matchBeliefFilter("historical")` inclusion were dormant.
 *
 * Pipeline
 * --------
 *   1. Walk every memory under `<stash>/memories/` and select candidates
 *      whose belief state is NOT already excluded
 *      ({contradicted, archived, deprecated}) AND whose `lastConfirmedAt`
 *      is absent or older than the configured threshold (default 90 days).
 *      Files without `lastConfirmedAt` fall back to file `mtime`.
 *   2. For each candidate, ask the configured validation-tier LLM
 *      (`resolveValidationRunner`) whether the candidate is still current
 *      given the top-K most-similar memories from the stash.
 *      Strict response contract: `YES\nSUPERSEDED_BY: <ref>` or `NO`.
 *      Anything else is treated as a parse error and the candidate is skipped.
 *   3. YES → write `beliefState: "deprecated"`, `supersededBy: [<ref>]`,
 *      `lastConfirmedAt: <now>`. The supersededBy ref MUST exist in the
 *      stash (DB lookup); if it doesn't, treat as NO.
 *      NO → write only `lastConfirmedAt: <now>` (refreshes the staleness
 *      window). All other frontmatter fields stay untouched.
 *
 * Caching
 * -------
 * Uses the standard `withLlmCache` wrapper with cacheVariant
 * `"staleness_detect"`, so re-running the pass on an unchanged file is a
 * no-op (no LLM call).
 *
 * Feature gate
 * ------------
 * Default OFF. Enable via `features.index.staleness_detection.enabled` (or
 * the boolean shorthand `features.index.staleness_detection = true`).
 * Threshold-days knob lives at
 * `features.index.staleness_detection.options.thresholdDays` (default 90).
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assembleAsset } from "../../core/asset/asset-serialize";
import { parseFrontmatter, parseFrontmatterBlock } from "../../core/asset/frontmatter";
import { concurrentMap } from "../../core/concurrent";
import { warn } from "../../core/warn";
import { resolveValidationRunner, runnerIsLlm } from "../../integrations/agent/runner";
import { type ChatMessage, chatCompletion } from "../../llm/client";
import { isProcessEnabled } from "../../llm/feature-gate";
import { findEntryIdByRef } from "../db/db";
import { withLlmCache } from "../db/llm-cache";
import { walkMarkdownFiles } from "../walk/walker";
import type { PassContext } from "./pass-context";

/** Frontmatter keys this pass touches. Constants so a future rename only needs to touch one site. */
const FM_BELIEF_STATE = "beliefState";
const FM_SUPERSEDED_BY = "supersededBy";
const FM_LAST_CONFIRMED_AT = "lastConfirmedAt";

/** Cache variant for `withLlmCache`. Keeps staleness results isolated from memory-inference cache rows. */
const CACHE_VARIANT = "staleness_detect";

/** Belief states excluded from staleness detection — already historical / archived. */
const EXCLUDED_BELIEF_STATES: ReadonlySet<string> = new Set(["contradicted", "archived", "deprecated"]);

/** Default threshold in days before a memory is re-evaluated. */
const DEFAULT_THRESHOLD_DAYS = 90;

/** Top-K similar memories included in the LLM prompt. */
const TOP_K_SIMILAR = 5;

/** Telemetry returned to the caller. */
export interface StalenessDetectionResult {
  considered: number;
  deprecated: number;
  confirmed: number;
  skipped: number;
  durationMs: number;
  warnings: string[];
}

interface CandidateMemory {
  filePath: string;
  ref: string;
  name: string;
  data: Record<string, unknown>;
  body: string;
  /** Latest of `lastConfirmedAt` frontmatter and file mtime; used for threshold comparison. */
  lastSignalMs: number;
}

interface CachedDecision {
  decision: "deprecated" | "confirmed";
  supersededBy?: string;
}

/**
 * Top-level entry point. Returns a zero-counters result when the feature is
 * disabled or no validation-tier runner is configured.
 */
export async function runStalenessDetectionPass(ctx: PassContext): Promise<StalenessDetectionResult> {
  const { config, sources, signal, db } = ctx;
  const start = Date.now();
  const result: StalenessDetectionResult = {
    considered: 0,
    deprecated: 0,
    confirmed: 0,
    skipped: 0,
    durationMs: 0,
    warnings: [],
  };

  // Feature gate — default OFF.
  if (!isProcessEnabled("index", "staleness_detection", config)) {
    result.durationMs = Date.now() - start;
    return result;
  }

  // The pass only writes to the primary (writable) stash. Read-only sources
  // would be clobbered by the next sync(), so we skip them entirely.
  const primary = sources[0];
  if (!primary) {
    result.durationMs = Date.now() - start;
    return result;
  }

  const runner = resolveValidationRunner(config);
  if (!runner) {
    result.warnings.push("staleness_detection: no validation runner configured; skipping pass");
    result.durationMs = Date.now() - start;
    return result;
  }
  if (!runnerIsLlm(runner)) {
    // MVP scope: only the LLM runner kind is supported. Agent/SDK runners
    // would require a different prompt-dispatch path that is out of scope
    // for the initial Phase 4A implementation.
    result.warnings.push(
      `staleness_detection: validation runner kind "${runner.kind}" not supported by MVP; configure an llm-kind validation profile`,
    );
    result.durationMs = Date.now() - start;
    return result;
  }

  const configuredThreshold = config.index?.stalenessDetection?.thresholdDays;
  const thresholdDays =
    typeof configuredThreshold === "number" && configuredThreshold >= 0 ? configuredThreshold : DEFAULT_THRESHOLD_DAYS;
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const candidates = collectStaleCandidates(primary.path, now, thresholdMs);
  result.considered = candidates.length;
  if (candidates.length === 0) {
    result.durationMs = Date.now() - start;
    return result;
  }

  const allMemories = collectAllMemoriesForSimilarity(primary.path);
  const nowIso = new Date(now).toISOString();
  const concurrency = runner.connection.concurrency ?? 1;

  const validate = (raw: unknown): CachedDecision | undefined => {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    if (r.decision === "deprecated") {
      if (typeof r.supersededBy === "string" && r.supersededBy.trim().length > 0) {
        return { decision: "deprecated", supersededBy: r.supersededBy.trim() };
      }
      return undefined;
    }
    if (r.decision === "confirmed") return { decision: "confirmed" };
    return undefined;
  };

  const perResult = await concurrentMap(
    candidates,
    async (candidate) => {
      if (signal?.aborted) return undefined;
      const cacheKey = candidate.filePath;
      const cacheBody = `${candidate.filePath}\n${candidate.body}`;

      const decision = db
        ? await withLlmCache<CachedDecision>(
            db,
            cacheKey,
            cacheBody,
            false,
            () => askValidator(runner.connection, candidate, allMemories, signal, runner.timeoutMs),
            validate,
            undefined,
            CACHE_VARIANT,
          )
        : await askValidator(runner.connection, candidate, allMemories, signal, runner.timeoutMs);

      return { candidate, decision };
    },
    concurrency,
  );

  for (const entry of perResult) {
    if (!entry) continue;
    const { candidate, decision } = entry;
    if (!decision) {
      result.skipped += 1;
      continue;
    }

    if (decision.decision === "deprecated") {
      const targetRef = decision.supersededBy ?? "";
      const validatedRef = validateSupersedingRef(targetRef, primary.path, db);
      if (!validatedRef) {
        // Spec line 153: never mark deprecated unless SUPERSEDED_BY exists.
        // Refresh lastConfirmedAt instead — the candidate is still our best
        // record until a real superseder shows up — and emit a warning.
        result.warnings.push(
          `staleness_detection: ${candidate.ref} reported superseded by "${targetRef}" but that ref does not exist; refreshing instead`,
        );
        try {
          writeLastConfirmed(candidate, nowIso);
          result.confirmed += 1;
        } catch (err) {
          result.warnings.push(
            `staleness_detection: failed to refresh ${candidate.ref}: ${err instanceof Error ? err.message : String(err)}`,
          );
          result.skipped += 1;
        }
        continue;
      }

      try {
        writeDeprecated(candidate, validatedRef, nowIso);
        result.deprecated += 1;
      } catch (err) {
        result.warnings.push(
          `staleness_detection: failed to deprecate ${candidate.ref}: ${err instanceof Error ? err.message : String(err)}`,
        );
        result.skipped += 1;
      }
    } else {
      try {
        writeLastConfirmed(candidate, nowIso);
        result.confirmed += 1;
      } catch (err) {
        result.warnings.push(
          `staleness_detection: failed to refresh ${candidate.ref}: ${err instanceof Error ? err.message : String(err)}`,
        );
        result.skipped += 1;
      }
    }
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ── Candidate collection ────────────────────────────────────────────────────

interface MemorySnapshot {
  ref: string;
  name: string;
  filePath: string;
  body: string;
  title: string;
  description: string;
  tokens: Set<string>;
  ageMs: number;
}

function collectStaleCandidates(stashRoot: string, now: number, thresholdMs: number): CandidateMemory[] {
  const memoriesDir = path.join(stashRoot, "memories");
  if (!fs.existsSync(memoriesDir)) return [];

  const out: CandidateMemory[] = [];
  for (const filePath of walkMarkdownFiles(memoriesDir)) {
    let raw: string;
    let stat: fs.Stats;
    try {
      raw = fs.readFileSync(filePath, "utf8");
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    const belief = typeof parsed.data[FM_BELIEF_STATE] === "string" ? (parsed.data[FM_BELIEF_STATE] as string) : "";
    if (EXCLUDED_BELIEF_STATES.has(belief)) continue;

    const lastConfirmedMs = parseDateMs(parsed.data[FM_LAST_CONFIRMED_AT]);
    const signalMs = lastConfirmedMs ?? stat.mtimeMs;
    const ageMs = now - signalMs;
    if (ageMs < thresholdMs) continue;

    const name = toMemoryName(memoriesDir, filePath);
    if (!name) continue;

    out.push({
      filePath,
      ref: `memory:${name}`,
      name,
      data: parsed.data,
      body: parsed.content,
      lastSignalMs: signalMs,
    });
  }
  return out;
}

function collectAllMemoriesForSimilarity(stashRoot: string): MemorySnapshot[] {
  const memoriesDir = path.join(stashRoot, "memories");
  if (!fs.existsSync(memoriesDir)) return [];

  const out: MemorySnapshot[] = [];
  const now = Date.now();
  for (const filePath of walkMarkdownFiles(memoriesDir)) {
    let raw: string;
    let stat: fs.Stats;
    try {
      raw = fs.readFileSync(filePath, "utf8");
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    const name = toMemoryName(memoriesDir, filePath);
    if (!name) continue;
    const title = typeof parsed.data.title === "string" ? parsed.data.title : "";
    const description = typeof parsed.data.description === "string" ? parsed.data.description : "";
    const body = parsed.content;
    out.push({
      ref: `memory:${name}`,
      name,
      filePath,
      body,
      title,
      description,
      tokens: tokenize(`${title} ${description} ${body}`),
      ageMs: now - stat.mtimeMs,
    });
  }
  return out;
}

function toMemoryName(memoriesDir: string, filePath: string): string | undefined {
  const rel = path.relative(memoriesDir, filePath);
  if (!rel || rel.startsWith("..")) return undefined;
  return rel.replace(/\\/g, "/").replace(/\.md$/i, "");
}

function parseDateMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// ── Similarity (lightweight FTS-style fallback) ─────────────────────────────

/**
 * Token-overlap similarity is the FTS fallback for the prompt's "similar
 * memories" payload. Embedding-aware nearest-neighbor lookup is a future
 * enhancement; the prompt only needs enough context to ground a YES/NO
 * decision, which token overlap of body + description provides.
 */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z0-9][a-z0-9_-]{2,}/g);
  if (!tokens) return out;
  for (const t of tokens) out.add(t);
  return out;
}

function pickSimilar(candidate: CandidateMemory, all: MemorySnapshot[]): MemorySnapshot[] {
  const candTokens = tokenize(
    `${typeof candidate.data.title === "string" ? candidate.data.title : ""} ${typeof candidate.data.description === "string" ? candidate.data.description : ""} ${candidate.body}`,
  );
  const candMs = candidate.lastSignalMs;
  const scored: Array<{ snap: MemorySnapshot; score: number }> = [];
  for (const snap of all) {
    if (snap.ref === candidate.ref) continue;
    // Prefer memories more recent than the candidate so the validator can
    // see what may have superseded it.
    if (snap.ageMs >= Date.now() - candMs) continue;
    let overlap = 0;
    for (const t of candTokens) if (snap.tokens.has(t)) overlap += 1;
    if (overlap === 0) continue;
    scored.push({ snap, score: overlap });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, TOP_K_SIMILAR).map((s) => s.snap);
}

// ── LLM dispatch ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a belief-state classifier for a memory store. Given a candidate memory and a list of more-recent similar memories from the same store, decide whether the candidate is still current or has been superseded.\n\n" +
  "Respond on the first line with exactly YES or NO.\n" +
  "If YES, the second line MUST be of the form `SUPERSEDED_BY: <ref>` where <ref> is the exact ref of the superseding memory from the list provided. Do NOT invent refs.\n" +
  "If NO, do not include any additional lines.\n" +
  "No prose, no preamble, no markdown.";

async function askValidator(
  connection: import("../../core/config/config").LlmConnectionConfig,
  candidate: CandidateMemory,
  allMemories: MemorySnapshot[],
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<CachedDecision | undefined> {
  const similar = pickSimilar(candidate, allMemories);
  if (similar.length === 0) {
    // No more-recent similar memories — there is nothing the candidate could
    // have been superseded by. Treat as confirmed without paying for an LLM call.
    return { decision: "confirmed" };
  }
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildPrompt(candidate, similar) },
  ];

  let raw: string;
  try {
    raw = await chatCompletion(connection, messages, {
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      ...(signal ? { signal } : {}),
      temperature: 0,
    });
  } catch (err) {
    warn(
      `[improve] staleness detection LLM call failed for ${candidate.ref}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  return parseStalenessResponse(raw);
}

export function buildPrompt(candidate: CandidateMemory, similar: MemorySnapshot[]): string {
  const lines: string[] = [];
  lines.push(`Candidate memory: ${candidate.ref}`);
  if (typeof candidate.data.title === "string" && candidate.data.title.trim().length > 0) {
    lines.push(`Title: ${candidate.data.title.trim()}`);
  }
  if (typeof candidate.data.description === "string" && candidate.data.description.trim().length > 0) {
    lines.push(`Description: ${candidate.data.description.trim()}`);
  }
  lines.push("Body:");
  lines.push(candidate.body.trim());
  lines.push("");
  lines.push(`Similar more-recent memories (top ${similar.length}):`);
  for (const s of similar) {
    lines.push("---");
    lines.push(`Ref: ${s.ref}`);
    if (s.title) lines.push(`Title: ${s.title}`);
    if (s.description) lines.push(`Description: ${s.description}`);
    lines.push("Body:");
    lines.push(s.body.trim());
  }
  lines.push("");
  lines.push(
    "Question: Given the more-recent similar memories above, has the candidate memory been superseded, or is it still current?",
  );
  return lines.join("\n");
}

/** Exported for direct unit testing. */
export function parseStalenessResponse(raw: string): CachedDecision | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;
  const head = lines[0]?.toUpperCase();
  if (head === "NO") return { decision: "confirmed" };
  if (head === "YES") {
    // Find the SUPERSEDED_BY line; tolerate it being anywhere in the body
    // but require an exact prefix match.
    for (const line of lines.slice(1)) {
      const m = line.match(/^SUPERSEDED_BY:\s*(\S.*)$/i);
      if (m?.[1]) {
        const ref = m[1].trim();
        if (ref.length > 0) return { decision: "deprecated", supersededBy: ref };
      }
    }
    return undefined; // YES without a SUPERSEDED_BY line is a parse error.
  }
  return undefined;
}

// ── Ref validation ──────────────────────────────────────────────────────────

/**
 * Validate that the proposed `supersededBy` ref actually exists. We first try
 * the indexed DB (canonical source of truth when available), then fall back to
 * an on-disk filesystem probe under `<stash>/memories/<name>.md` so the pass
 * works even on stashes that have never been indexed.
 */
function validateSupersedingRef(refStr: string, stashRoot: string, db?: Database): string | undefined {
  const trimmed = refStr.trim();
  if (!trimmed) return undefined;
  if (db) {
    try {
      const id = findEntryIdByRef(db, trimmed);
      if (typeof id === "number") return trimmed;
    } catch {
      // Fall through to filesystem probe.
    }
  }
  const m = trimmed.match(/^memory:(.+)$/);
  if (!m) return undefined;
  const filePath = path.join(stashRoot, "memories", `${m[1]}.md`);
  if (fs.existsSync(filePath)) return trimmed;
  return undefined;
}

// ── Frontmatter writes ──────────────────────────────────────────────────────

/**
 * Write `beliefState: deprecated`, `supersededBy`, and `lastConfirmedAt` to
 * the candidate's frontmatter. All other fields are preserved verbatim. Uses
 * the same atomic-write shape as `markParentProcessed()` in
 * `memory-inference.ts`: re-read the file from disk, parse the YAML block,
 * stitch a new block in front of the original body bytes.
 */
function writeDeprecated(candidate: CandidateMemory, supersededByRef: string, nowIso: string): void {
  const raw = fs.readFileSync(candidate.filePath, "utf8");
  const block = parseFrontmatterBlock(raw);
  const baseFm: Record<string, unknown> = block ? { ...parseFrontmatter(raw).data } : {};
  const nextFm: Record<string, unknown> = {
    ...baseFm,
    [FM_BELIEF_STATE]: "deprecated",
    [FM_SUPERSEDED_BY]: dedupeStringArray([...stringArrayOrEmpty(baseFm[FM_SUPERSEDED_BY]), supersededByRef]),
    [FM_LAST_CONFIRMED_AT]: nowIso,
  };
  writeFrontmatterAtomic(candidate.filePath, nextFm, block?.content ?? raw);
}

/**
 * Strict additive frontmatter write: ONLY `lastConfirmedAt` is touched.
 * Every other field in the file is preserved as-is.
 */
function writeLastConfirmed(candidate: CandidateMemory, nowIso: string): void {
  const raw = fs.readFileSync(candidate.filePath, "utf8");
  const block = parseFrontmatterBlock(raw);
  const baseFm: Record<string, unknown> = block ? { ...parseFrontmatter(raw).data } : {};
  const nextFm: Record<string, unknown> = {
    ...baseFm,
    [FM_LAST_CONFIRMED_AT]: nowIso,
  };
  writeFrontmatterAtomic(candidate.filePath, nextFm, block?.content ?? raw);
}

function writeFrontmatterAtomic(filePath: string, frontmatter: Record<string, unknown>, body: string): void {
  fs.writeFileSync(filePath, assembleAsset(frontmatter, body), "utf8");
}

function stringArrayOrEmpty(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function dedupeStringArray(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

// ── Body hash helper (exported for tests) ───────────────────────────────────

/** Internal helper exported only for testing — mirrors `computeBodyHash`. */
export function _stalenessBodyHash(filePath: string, body: string): string {
  return createHash("sha256").update(`${filePath}\n${body}`).digest("hex");
}
