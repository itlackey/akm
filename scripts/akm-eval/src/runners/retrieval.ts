/**
 * Retrieval runner — verifies `akm search` returns the right refs/keywords
 * for a query.
 *
 * Inputs:  { query: string; topK?: number; type?: string }
 * Expected: { mustIncludeRefs?: string[]; mustNotIncludeRefs?: string[];
 *             keywords?: string[] }
 * Default weights: mustIncludeRefs 0.6, keywordCoverage 0.3, noForbiddenRefs 0.1
 */

import type { EvalCase, EvalCaseResult, EvalContext } from "../types";
import { AkmCli, type SearchHit } from "../sources/akm-cli";

export async function runRetrievalCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  const query = String(c.input.query ?? "");
  const topK = Number(c.input.topK ?? 5);
  const type = c.input.type as string | undefined;
  const expected = c.expected as {
    mustIncludeRefs?: string[];
    mustNotIncludeRefs?: string[];
    keywords?: string[];
    minHits?: number;
  };

  if (!query) {
    return errorResult(c, "case is missing `input.query`", start);
  }

  const cli = new AkmCli(ctx.akmBin, ctx.env);
  let hits;
  try {
    hits = cli.search(query, { limit: topK, type });
  } catch (err) {
    return errorResult(c, err instanceof Error ? err.message : String(err), start);
  }

  const refs = hits.map((h) => h.ref);
  const text = hits
    .map((h) => `${h.ref} ${h.name ?? ""} ${h.description ?? ""} ${h.snippet ?? ""}`)
    .join("\n")
    .toLowerCase();

  const mustInclude = expected.mustIncludeRefs ?? [];
  const mustNotInclude = expected.mustNotIncludeRefs ?? [];
  const keywords = expected.keywords ?? [];
  const minHits = expected.minHits ?? 0;

  const includeScore =
    mustInclude.length === 0
      ? 1
      : mustInclude.filter((r) => refs.includes(r)).length / mustInclude.length;
  const forbiddenHits = mustNotInclude.filter((r) => refs.includes(r));
  const forbiddenScore = forbiddenHits.length === 0 ? 1 : 0;
  const keywordHits = keywords.filter((k) => text.includes(k.toLowerCase()));
  const keywordScore = keywords.length === 0 ? 1 : keywordHits.length / keywords.length;
  const minHitsScore = minHits === 0 ? 1 : hits.length >= minHits ? 1 : hits.length / minHits;

  const w = c.scoring?.weights ?? {
    mustIncludeRefs: 0.6,
    keywordCoverage: 0.3,
    noForbiddenRefs: 0.1,
  };
  const sumW =
    (w.mustIncludeRefs ?? 0) +
    (w.keywordCoverage ?? 0) +
    (w.noForbiddenRefs ?? 0) +
    (w.minHits ?? 0);
  const score =
    sumW === 0
      ? 0
      : (includeScore * (w.mustIncludeRefs ?? 0) +
          keywordScore * (w.keywordCoverage ?? 0) +
          forbiddenScore * (w.noForbiddenRefs ?? 0) +
          minHitsScore * (w.minHits ?? 0)) /
        sumW;

  const passThreshold = c.scoring?.passThreshold ?? 0.8;

  return {
    caseId: c.id,
    type: "retrieval",
    score,
    passed: score >= passThreshold,
    metrics: {
      includeScore,
      keywordScore,
      forbiddenScore,
      minHitsScore,
      hitAt1: mustInclude.length === 0 ? null : refs[0] !== undefined && mustInclude.includes(refs[0]),
      hitAtK: includeScore > 0,
      forbiddenHits,
      keywordHits,
      hitCount: hits.length,
    },
    evidence: {
      query,
      topK,
      refs,
      // Phase 7: a compact, human-readable artifact for optional LLM
      // judging. Pre-formatted here so cases can point their judge
      // rubric at `evidence.topHitArtifact` without runner changes.
      topHitArtifact: formatTopHitArtifact(query, hits.slice(0, 3)),
    },
    durationMs: Date.now() - start,
  };
}

function formatTopHitArtifact(query: string, top: SearchHit[]): string {
  const lines: string[] = [`Query: ${query}`, "", "Top hits:"];
  for (const h of top) {
    const ref = h.ref ?? "";
    const name = h.name ? ` — ${h.name}` : "";
    const type = h.type ? ` [${h.type}]` : "";
    const desc = (h.description ?? h.snippet ?? "").trim();
    lines.push(`- ${ref}${name}${type}`);
    if (desc) lines.push(`    ${desc.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  return lines.join("\n");
}

function errorResult(c: EvalCase, message: string, start: number): EvalCaseResult {
  return {
    caseId: c.id,
    type: "retrieval",
    score: 0,
    passed: false,
    metrics: {},
    evidence: {},
    errors: [message],
    durationMs: Date.now() - start,
  };
}
