// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ── Deterministic near-duplicate MEMORY dedup (#617) ─────────────────────────
//
// A CHEAP, DETERMINISTIC fast path that collapses the obvious duplicates with
// NO LLM call, run in front of the embedding-clustered LLM consolidation pass
// (see consolidate.ts). The working stash accumulates near-duplicates faster
// than the capped/rotating LLM consolidate pass can merge them; this pre-pass
// clears the unambiguous twins so the (expensive) LLM only ever sees genuinely
// distinct-but-related memories.
//
// Two collapse classes, both safe and reversible (archive + backup at the call
// site in consolidate.ts; this module only computes the plan and applies the
// file writes/deletes):
//
//   1. `.derived` ↔ origin pairs — a memory-inference `<parent>.derived` child
//      whose normalized body is identical to (or, with embeddings, ≥ the strict
//      cosine threshold of) its origin. Keep the canonical (non-derived) origin;
//      drop the derived variant; preserve the variant's provenance on the
//      canonical (`dedupedFrom`).
//
//   2. Content twins — two non-derived memories with identical normalized body
//      hash, or ≥ the strict cosine threshold. Keep the deterministic canonical
//      (lexicographically smallest name); merge the other into it, preserving
//      provenance.
//
// Determinism: the plan is a pure function of the on-disk memory set + config.
// Nothing here reads Date.now()/Math.random(); ordering is by memory name so the
// canonical choice and op order are stable across runs.
//
// Gating: DEFAULT OFF. The pre-pass only runs when `dedup.enabled === true`. The
// cosine path additionally requires an embedding config; absent embeddings the
// pass still collapses exact normalized-hash twins. `cosineThreshold` defaults
// to 0.97 — a strict floor chosen so distinct-but-related memories fall through
// untouched to the LLM consolidation.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { assembleAssetFromString, serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import type { AkmConfig } from "../../core/config/config";
import type { Database } from "../../core/state-db";
import { getBodyEmbeddings, upsertBodyEmbeddings } from "../../core/state-db";
import { warn } from "../../core/warn";
import { cosineSimilarity, embedBatch, resolveEmbeddingModelId } from "../../llm/embedder";

/** Default strict cosine floor — high enough to skip distinct-but-related memories. */
export const DEFAULT_DEDUP_COSINE_THRESHOLD = 0.97;

export interface DedupConfig {
  enabled?: boolean;
  cosineThreshold?: number;
  /**
   * Maximum pool size for the O(n²) cosine-similarity twin compare.
   * When the judged-cache-miss pool exceeds this limit only the first
   * `cosineCandidateLimit` items (sorted lexicographically, which is the
   * deterministic canonical order) are cosine-compared. Exact-hash matches
   * still run over the full pool regardless. Default: 500 (~125 K comparisons,
   * ≈ 0.1 s on modern hardware). At pools > ~1 k, consider switching to
   * sqlite-vec KNN (tier C, 0.10+).
   */
  cosineCandidateLimit?: number;
}

/** A single memory file loaded from the stash for the dedup pre-pass. */
export interface DedupMemory {
  name: string;
  filePath: string;
  /** True when the name ends in `.derived` (memory-inference child). */
  derived: boolean;
  /** `derivedFrom` frontmatter value (origin name) for `.derived` children. */
  derivedFrom?: string;
  /** Raw on-disk content. */
  raw: string;
  /** Normalized body (frontmatter stripped) used for hash equality. */
  normalizedBody: string;
  /** sha256 of the normalized body. */
  bodyHash: string;
  /** True when `captureMode: hot` — never collapse these. */
  hot: boolean;
}

/** A planned collapse: keep `canonical`, drop `variant`. */
export interface DedupCollapse {
  /** The memory to keep (non-derived / lexicographically smallest). */
  canonical: string;
  /** The memory to drop and fold into the canonical. */
  variant: string;
  /** How the pair was matched. */
  via: "derived-hash" | "derived-cosine" | "twin-hash" | "twin-cosine";
  /** Cosine similarity for cosine matches; undefined for exact-hash matches. */
  similarity?: number;
}

export interface DedupPlan {
  collapses: DedupCollapse[];
  warnings: string[];
}

export interface DedupResult {
  /** Number of variant memories collapsed (each removed exactly one file). */
  collapsed: number;
  /** Refs (`memory:<name>`) consumed (the dropped variants). */
  consumedRefs: string[];
  warnings: string[];
}

/**
 * Strip frontmatter from raw memory content, returning the body text trimmed.
 * Case and whitespace are preserved — this is the shared primitive used by
 * both hash wrappers below. Falls back to `raw.trim()` on unparseable
 * frontmatter (consistent with the pre-existing load-time hot guard).
 */
export function stripFrontmatterBody(raw: string): string {
  try {
    return parseFrontmatter(raw).content.trim();
  } catch {
    return raw.trim();
  }
}

/**
 * Normalize a memory body for content-twin equality. Strips frontmatter,
 * lowercases, trims, and collapses all runs of whitespace to a single space so
 * trivial reformatting (extra blank lines, trailing spaces, case) does not
 * defeat the hash. Deterministic and pure.
 *
 * Use this for the DEDUP path only (exact-twin detection). For the change-
 * detection / embedding-cache path use `cacheHash` instead.
 */
export function normalizeMemoryBody(raw: string): string {
  return stripFrontmatterBody(raw).toLowerCase().replace(/\s+/g, " ");
}

/**
 * Hash used for content-twin detection: lowercase + whitespace-collapsed body.
 * Two memories that differ only in case or whitespace produce the same hash
 * and are considered identical twins. Use this key for the dedup buckets.
 */
export function dedupHash(raw: string): string {
  return createHash("sha256").update(normalizeMemoryBody(raw), "utf8").digest("hex");
}

/**
 * Hash used for change-detection and the body-embedding cache: case-/whitespace-
 * preserving stripped body. Two memories with the same wording but different
 * casing produce DIFFERENT hashes here, which is intentional — we embed the
 * exact text and cache by its precise content.
 *
 * This is the `content_hash` stored in `body_embeddings` and
 * `consolidation_judged`. Do NOT reuse the `dedupHash` for those tables.
 */
export function cacheHash(raw: string): string {
  return createHash("sha256").update(stripFrontmatterBody(raw), "utf8").digest("hex");
}

/**
 * Load every memory `.md` file (including `.derived` children) from the stash
 * memories directory. Unlike the consolidate loader, this DOES include derived
 * children — the whole point of class 1 is to collapse a derived child into its
 * origin, so both must be visible here.
 */
export function loadDedupMemories(stashDir: string): DedupMemory[] {
  const memoriesDir = path.join(stashDir, "memories");
  if (!fs.existsSync(memoriesDir)) return [];
  const out: DedupMemory[] = [];
  for (const fname of fs.readdirSync(memoriesDir).sort()) {
    if (!fname.endsWith(".md")) continue;
    const name = fname.replace(/\.md$/, "");
    const filePath = path.join(memoriesDir, fname);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let fm: Record<string, unknown> = {};
    try {
      fm = (parseFrontmatter(raw).data as Record<string, unknown>) ?? {};
    } catch {
      fm = {};
    }
    const normalizedBody = normalizeMemoryBody(raw);
    out.push({
      name,
      filePath,
      derived: name.endsWith(".derived"),
      derivedFrom: typeof fm.derivedFrom === "string" ? (fm.derivedFrom as string) : undefined,
      raw,
      normalizedBody,
      bodyHash: dedupHash(raw),
      hot: fm.captureMode === "hot",
    });
  }
  return out;
}

/** Default cap on the O(n²) cosine-compare pool size. */
export const DEFAULT_COSINE_CANDIDATE_LIMIT = 500;

/**
 * Build the deterministic collapse plan. Pure over (memories, similarities,
 * threshold) — `embeddings` is optional; when absent only exact normalized-hash
 * twins are matched.
 *
 * Pass invariants:
 *   - A memory is consumed (collapsed) at most once.
 *   - Hot (captureMode: hot) memories are never collapsed, as canonical OR
 *     variant — user-explicit, only the user retires them.
 *   - Class 1 (`.derived` ↔ origin) is matched first so a derived child is
 *     always folded into its origin (never the reverse, never twin-matched).
 */

export function planDedup(
  memories: DedupMemory[],
  opts: { cosineThreshold: number; embeddings?: Map<string, number[]>; cosineCandidateLimit?: number },
): DedupPlan {
  const collapses: DedupCollapse[] = [];
  const warnings: string[] = [];
  const consumed = new Set<string>();
  const threshold = opts.cosineThreshold;

  const byName = new Map<string, DedupMemory>();
  for (const m of memories) byName.set(m.name, m);

  const sim = (a: DedupMemory, b: DedupMemory): number | undefined => {
    if (!opts.embeddings) return undefined;
    const ea = opts.embeddings.get(a.name);
    const eb = opts.embeddings.get(b.name);
    if (!ea || !eb) return undefined;
    return cosineSimilarity(ea, eb);
  };

  // ── Class 1: `.derived` children ↔ their origin ────────────────────────────
  // Iterate derived children in sorted order (loadDedupMemories sorts), folding
  // each into its origin when near-identical.
  const derived = memories.filter((m) => m.derived).sort((a, b) => a.name.localeCompare(b.name));
  for (const child of derived) {
    if (consumed.has(child.name)) continue;
    if (child.hot) continue;
    const originName = child.derivedFrom ?? child.name.replace(/\.derived$/, "");
    const origin = byName.get(originName);
    if (!origin || consumed.has(origin.name) || origin.derived || origin.hot) continue;

    let via: DedupCollapse["via"] | undefined;
    let similarity: number | undefined;
    if (child.bodyHash === origin.bodyHash) {
      via = "derived-hash";
    } else {
      const s = sim(child, origin);
      if (s !== undefined && s >= threshold) {
        via = "derived-cosine";
        similarity = s;
      }
    }
    if (!via) continue;

    collapses.push({ canonical: origin.name, variant: child.name, via, similarity });
    consumed.add(child.name);
  }

  // ── Class 2: content twins among non-derived memories ──────────────────────
  // Bucket by exact normalized-hash first (cheap, transitive, deterministic).
  const remaining = memories
    .filter((m) => !m.derived && !m.hot && !consumed.has(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const hashBuckets = new Map<string, DedupMemory[]>();
  for (const m of remaining) {
    const list = hashBuckets.get(m.bodyHash);
    if (list) list.push(m);
    else hashBuckets.set(m.bodyHash, [m]);
  }
  for (const bucket of hashBuckets.values()) {
    if (bucket.length < 2) continue;
    // Canonical = lexicographically smallest name (already sorted).
    const canonical = bucket[0] as DedupMemory;
    for (let i = 1; i < bucket.length; i++) {
      const variant = bucket[i] as DedupMemory;
      if (consumed.has(variant.name)) continue;
      collapses.push({ canonical: canonical.name, variant: variant.name, via: "twin-hash" });
      consumed.add(variant.name);
    }
    consumed.add(canonical.name); // canonical kept but no longer a twin candidate
  }

  // Cosine twins (only when embeddings are available). O(n²) over the still-
  // unconsumed non-derived pool; deterministic greedy: for each canonical in
  // sorted order, claim every unconsumed later memory whose similarity ≥ floor.
  // The pool is capped at `cosineCandidateLimit` (default 500) to bound the
  // O(n²) cost (~0.1 s at 500; ~3 s at 2.6 k; ~85 s at 13 k). Exact-hash
  // matches above always run over the full pool and are unaffected.
  if (opts.embeddings) {
    const limit = opts.cosineCandidateLimit ?? DEFAULT_COSINE_CANDIDATE_LIMIT;
    const fullPool = remaining.filter((m) => !consumed.has(m.name));
    const pool = fullPool.length > limit ? fullPool.slice(0, limit) : fullPool;
    if (fullPool.length > limit) {
      warnings.push(
        `dedup: cosine compare pool (${fullPool.length}) exceeds cosineCandidateLimit (${limit}); capping to first ${limit} memories (exact-hash matches unaffected).`,
      );
    }
    for (let i = 0; i < pool.length; i++) {
      const canonical = pool[i] as DedupMemory;
      if (consumed.has(canonical.name)) continue;
      for (let j = i + 1; j < pool.length; j++) {
        const variant = pool[j] as DedupMemory;
        if (consumed.has(variant.name)) continue;
        const s = sim(canonical, variant);
        if (s !== undefined && s >= threshold) {
          collapses.push({ canonical: canonical.name, variant: variant.name, via: "twin-cosine", similarity: s });
          consumed.add(variant.name);
        }
      }
      consumed.add(canonical.name);
    }
  }

  return { collapses, warnings };
}

/**
 * Fold a dropped variant's provenance into the canonical's frontmatter. Appends
 * the variant ref to a `dedupedFrom` list (deduplicated, sorted) and carries
 * any `source`/`sources` references the variant held that the canonical lacks.
 * Pure string→string; never invents timestamps.
 */
export function applyProvenance(canonicalRaw: string, variant: DedupMemory): string {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(canonicalRaw);
  } catch {
    // Canonical frontmatter unparseable — leave content untouched (the file is
    // never collapsed AS a canonical when hot/unparseable is the variant, but
    // the canonical itself can still be odd; preserve bytes).
    return canonicalRaw;
  }
  const fm: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>) };

  const variantRef = `memory:${variant.name}`;
  const existing = Array.isArray(fm.dedupedFrom)
    ? (fm.dedupedFrom as unknown[]).filter((v): v is string => typeof v === "string")
    : typeof fm.dedupedFrom === "string"
      ? [fm.dedupedFrom as string]
      : [];
  const next = Array.from(new Set([...existing, variantRef])).sort();
  fm.dedupedFrom = next;

  return assembleAssetFromString(serializeFrontmatter(fm), parsed.content);
}

/**
 * Apply a collapse plan to disk: rewrite each canonical with merged provenance,
 * delete each variant. Returns counts + consumed refs so the consolidate pass
 * can prune them from the LLM pool. NO LLM call.
 *
 * `onArchive` (optional) is invoked with the variant file path before deletion
 * so the caller can archive/back up exactly as it does for LLM merges.
 */
export function applyDedupPlan(
  plan: DedupPlan,
  memories: DedupMemory[],
  onArchive?: (variant: DedupMemory) => void,
): DedupResult {
  const byName = new Map<string, DedupMemory>();
  for (const m of memories) byName.set(m.name, m);

  const warnings = [...plan.warnings];
  const consumedRefs: string[] = [];
  let collapsed = 0;

  // Accumulate provenance per canonical so multiple variants folding into the
  // same canonical produce a single rewrite.
  const provByCanonical = new Map<string, DedupMemory[]>();
  for (const c of plan.collapses) {
    const list = provByCanonical.get(c.canonical);
    if (list) list.push(byName.get(c.variant) as DedupMemory);
    else provByCanonical.set(c.canonical, [byName.get(c.variant) as DedupMemory]);
  }

  // 1. Rewrite canonicals with merged provenance.
  for (const [canonicalName, variants] of provByCanonical) {
    const canonical = byName.get(canonicalName);
    if (!canonical) continue;
    let content = canonical.raw;
    for (const v of variants.filter((x) => x).sort((a, b) => a.name.localeCompare(b.name))) {
      content = applyProvenance(content, v);
    }
    try {
      fs.writeFileSync(canonical.filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    } catch (e) {
      warnings.push(`dedup: failed to rewrite canonical ${canonicalName}: ${String(e)}`);
    }
  }

  // 2. Delete variants (archive first if requested).
  for (const c of plan.collapses) {
    const variant = byName.get(c.variant);
    if (!variant) continue;
    if (!fs.existsSync(variant.filePath)) {
      warnings.push(`dedup: variant ${c.variant} already absent — skipping delete.`);
      continue;
    }
    if (onArchive) {
      try {
        onArchive(variant);
      } catch {
        // best-effort archival; deletion proceeds
      }
    }
    try {
      fs.unlinkSync(variant.filePath);
      collapsed++;
      consumedRefs.push(`memory:${variant.name}`);
    } catch (e) {
      warnings.push(`dedup: failed to delete variant ${c.variant}: ${String(e)}`);
    }
  }

  return { collapsed, consumedRefs, warnings };
}

/**
 * Top-level entry point for the consolidate pre-pass. Loads memories, optionally
 * embeds them (only when a cosine path is reachable), plans, and applies the
 * collapse. DEFAULT OFF — returns a no-op result when `config.enabled !== true`.
 *
 * `onArchive` lets the caller archive/back up each dropped variant before
 * deletion (consolidate.ts wires this to its existing archive helper).
 *
 * `signal` (optional): an AbortSignal forwarded from the caller's budget
 * controller. When aborted before the embedding call the function returns a
 * no-op result immediately; the signal is also forwarded into `embedBatch`
 * so a mid-embedding abort is handled cleanly.
 */
export async function runDeterministicDedup(
  stashDir: string,
  dedupConfig: DedupConfig | undefined,
  akmConfig: AkmConfig,
  onArchive?: (variantFilePath: string, variantName: string) => void,
  signal?: AbortSignal,
  /** Optional open state.db handle for the body-embedding cache (WS-3a). */
  stateDb?: Database,
): Promise<DedupResult> {
  if (!dedupConfig?.enabled) {
    return { collapsed: 0, consumedRefs: [], warnings: [] };
  }
  if (signal?.aborted) {
    return { collapsed: 0, consumedRefs: [], warnings: ["dedup: aborted before start"] };
  }
  const threshold = dedupConfig.cosineThreshold ?? DEFAULT_DEDUP_COSINE_THRESHOLD;
  const candidateLimit = dedupConfig.cosineCandidateLimit ?? DEFAULT_COSINE_CANDIDATE_LIMIT;

  const memories = loadDedupMemories(stashDir);
  if (memories.length === 0) {
    return { collapsed: 0, consumedRefs: [], warnings: [] };
  }

  // Embed only when embeddings are configured — exact-hash collapse still works
  // without them. Fail-open: any embedding error degrades to hash-only matching.
  // NOTE: embedBatch embeds the case-preserving stripped body (cacheHash domain),
  // not the lowercase dedupHash body, so dedup cosine and the body_embeddings
  // cache share the same canonical embedding input.
  let embeddings: Map<string, number[]> | undefined;
  if (akmConfig.embedding) {
    try {
      const eligible = memories.filter((m) => !m.hot);
      // Use the case-preserving stripped body for embeddings (matching cacheHash
      // canonical input) so the embedding cache can be shared with consolidate.
      const modelId = resolveEmbeddingModelId(akmConfig.embedding);

      // WS-3a: body-embedding cache — look up all content_hashes in one query,
      // embed only the misses, then upsert the new vectors in one transaction.
      const contentHashes = eligible.map((m) => cacheHash(m.raw));
      const hashToName = new Map<string, string>();
      for (let i = 0; i < eligible.length; i++) {
        hashToName.set(contentHashes[i] as string, (eligible[i] as DedupMemory).name);
      }

      let cachedVecs = new Map<string, number[]>();
      if (stateDb) {
        try {
          cachedVecs = getBodyEmbeddings(stateDb, contentHashes, modelId);
        } catch {
          // Fail open: cache read errors degrade to full embed.
          cachedVecs = new Map();
        }
      }

      const missIndices: number[] = [];
      const missTexts: string[] = [];
      for (let i = 0; i < eligible.length; i++) {
        const hash = contentHashes[i] as string;
        if (!cachedVecs.has(hash)) {
          missIndices.push(i);
          missTexts.push(stripFrontmatterBody((eligible[i] as DedupMemory).raw) || (eligible[i] as DedupMemory).name);
        }
      }

      let missVecs: number[][] = [];
      if (missTexts.length > 0) {
        missVecs = await embedBatch(missTexts, akmConfig.embedding, signal);
        // Upsert new vectors into cache.
        if (stateDb && missVecs.length === missTexts.length) {
          try {
            const toUpsert = missIndices.map((idx, pos) => ({
              contentHash: contentHashes[idx] as string,
              embedding: missVecs[pos] as number[],
              modelId,
            }));
            upsertBodyEmbeddings(stateDb, toUpsert);
          } catch {
            // Fail open: cache write errors are non-fatal.
          }
        }
      }

      // Assemble the full embeddings map (cache hits + freshly embedded misses).
      if (missVecs.length === missTexts.length || cachedVecs.size > 0) {
        embeddings = new Map<string, number[]>();
        // Add cache hits.
        for (let i = 0; i < eligible.length; i++) {
          const hash = contentHashes[i] as string;
          const cached = cachedVecs.get(hash);
          if (cached) embeddings.set((eligible[i] as DedupMemory).name, cached);
        }
        // Add freshly embedded misses.
        for (let pos = 0; pos < missIndices.length; pos++) {
          const idx = missIndices[pos] as number;
          const vec = missVecs[pos];
          if (vec) embeddings.set((eligible[idx] as DedupMemory).name, vec);
        }
      }
    } catch {
      embeddings = undefined;
    }
  }

  const plan = planDedup(memories, { cosineThreshold: threshold, embeddings, cosineCandidateLimit: candidateLimit });
  if (plan.collapses.length === 0) {
    return { collapsed: 0, consumedRefs: [], warnings: plan.warnings };
  }

  // Sanity: every variant ref must be a parseable memory ref before we touch
  // disk (defends against a malformed name slipping through).
  for (const c of plan.collapses) {
    try {
      parseAssetRef(`memory:${c.variant}`);
      parseAssetRef(`memory:${c.canonical}`);
    } catch {
      plan.warnings.push(`dedup: unparseable ref in collapse ${c.canonical} ← ${c.variant} — dropping op.`);
    }
  }

  const result = applyDedupPlan(plan, memories, (v) => onArchive?.(v.filePath, v.name));
  if (result.collapsed > 0) {
    warn(
      `[consolidate] deterministic dedup collapsed ${result.collapsed} near-duplicate memor${result.collapsed === 1 ? "y" : "ies"} (no LLM).`,
    );
  }
  return result;
}
