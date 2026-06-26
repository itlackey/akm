// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Chunk sizing + per-chunk prompt assembly for consolidate. Pure token math and
// prompt-string construction over MemoryEntry inputs — no LLM call, no embedder,
// no orchestrator coupling.

import fs from "node:fs";
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import { cacheHash } from "../dedup";
import type { MemoryEntry } from "./types";

/**
 * Conservative chars-per-token estimate used when computing prompt budgets.
 * English text averages roughly 4 chars/token for most LLM tokenizers. We use
 * 3 to stay conservative (shorter tokens = more tokens per char).
 */
const CHARS_PER_TOKEN = 3;

/**
 * Overhead budget reserved for the system prompt, chunk header lines, and per-
 * memory metadata lines (name, description, tags, separator). Measured at
 * roughly 600 chars for the system prompt + ~100 chars of header + ~50 chars
 * per memory × chunk size.  We round up to 2 000 tokens to leave room for the
 * model's own output.
 */
const PROMPT_OVERHEAD_TOKENS = 2_000;

/**
 * Default effective token budget used when the default LLM profile's
 * `contextLength` is not set. This is intentionally conservative (4 096)
 * rather than being set to the model's actual context window, because:
 *
 *   - When the agent path is used, the agent CLI (e.g. opencode)
 *     prepends its own large system prompt + conversation history before
 *     forwarding to the model. That overhead easily consumes 30K+ tokens on
 *     a model with a 16K context window, leaving very little room for
 *     chunk content.
 *   - When the HTTP path is used (an LLM profile is selected), only the akm
 *     system prompt and user prompt are sent, so the budget can be set to the
 *     model's actual context length via profiles.llm[defaults.llm].contextLength.
 *
 * Set profiles.llm[defaults.llm].contextLength in your config file to the
 * model's actual context window to allow larger chunks on the HTTP path.
 */
export const DEFAULT_CONTEXT_LENGTH_TOKENS = 4_096;

/**
 * Given the model's context window and the per-memory body truncation limit,
 * return the maximum number of memories that can safely fit in one chunk
 * without the prompt overflowing the context window.
 *
 * The formula is:
 *   usableTokens = contextLength - PROMPT_OVERHEAD_TOKENS
 *   tokensPerMemory = ceil(bodyTruncation / CHARS_PER_TOKEN)
 *   chunkSize = floor(usableTokens / tokensPerMemory)
 *
 * Result is clamped between 1 and 50 to avoid degenerate values.
 *
 * @param contextLength - Model context window in tokens.
 * @param bodyTruncation - Max chars per memory body included in the prompt.
 * @param maxChunkSize - Optional override for the hardcoded cap of 50 (1–50).
 */
export function computeSafeChunkSize(contextLength: number, bodyTruncation: number, maxChunkSize?: number): number {
  const usableTokens = Math.max(contextLength - PROMPT_OVERHEAD_TOKENS, 0);
  const tokensPerMemory = Math.max(Math.ceil(bodyTruncation / CHARS_PER_TOKEN), 1);
  const raw = Math.floor(usableTokens / tokensPerMemory);
  return Math.max(1, Math.min(maxChunkSize ?? 50, raw));
}

/**
 * Build the per-chunk user prompt fed to the consolidate LLM.
 *
 * Each memory is annotated with two flags that drive the system-prompt
 * rules at lines 181-186:
 *   - `(captureMode: hot)` — user-explicit memory; system prompt rule 2
 *     forbids proposing delete. ~60 wasted LLM verdicts/4h on this user's
 *     stack before this annotation.
 *   - `(already queued)` — the memory's body hash matches a pending
 *     consolidate proposal; system prompt rule 3 forbids proposing
 *     promote/merge/contradict. ~107/4h before this annotation.
 *
 * Both annotations are visible to the LLM. `pendingProposalBodyHashes`
 * is precomputed once per run by `loadPendingConsolidateProposalHashes`
 * so the cost stays O(memories) inside the chunk loop.
 */
export function buildChunkPrompt(
  sourceName: string,
  memories: MemoryEntry[],
  chunkIndex: number,
  totalChunks: number,
  bodyTruncation: number,
  pendingProposalBodyHashes: Set<string> = new Set(),
  standardsContext = "",
): string {
  const start = memories[0] ? `memory:${memories[0].name}` : "";
  const end = memories[memories.length - 1] ? `memory:${memories[memories.length - 1].name}` : "";

  // First pass: classify each memory's annotations + collect hot refs so a
  // prominent top-of-prompt list can be emitted. 2026-05-27 controlled
  // diagnostic (/tmp/akm-health-investigations/ministral-prompt-annotation-diagnostic.md)
  // measured ministral-3-3b compliance:
  //   - inline `(captureMode: hot)` only → 40% honored
  //   - inline parens + top-of-prompt explicit list → 100% honored
  // The `(already queued)` annotation tops out at ~60% regardless of
  // format, so it stays inline-only here — a separate chunk-filter is
  // the right approach for queued refs (deferred per user direction).
  type MemoryAnnotation = { isHot: boolean; isAlreadyQueued: boolean; body: string };
  const annotationsByIndex: MemoryAnnotation[] = [];
  const hotRefs: string[] = [];
  for (const m of memories) {
    let body = "";
    try {
      body = fs.readFileSync(m.filePath, "utf8");
    } catch {
      body = "(unreadable)";
    }
    const parsed = parseFrontmatter(body);
    const isHot = parsed.data.captureMode === "hot";
    // Use cacheHash (case-preserving stripped body) to match the domain used
    // by loadPendingConsolidateProposalHashes and the body-embedding cache.
    const bodyHash = cacheHash(body);
    const isAlreadyQueued = pendingProposalBodyHashes.has(bodyHash);
    annotationsByIndex.push({ isHot, isAlreadyQueued, body });
    if (isHot) hotRefs.push(`memory:${m.name}`);
  }

  const lines: string[] = [
    `Source: ${sourceName}`,
    `Chunk ${chunkIndex + 1} of ${totalChunks}, memories ${start}–${end}:`,
    "",
  ];

  if (standardsContext.trim()) {
    lines.push("Standards to follow (the rulebook for this target):");
    lines.push(standardsContext.trim());
    lines.push("");
  }

  // Top-of-prompt protection block for hot refs. Neutral phrasing — avoid
  // op-words like "promote", "merge", "contradict" so the model doesn't
  // accidentally treat the warning as a hint to use that op elsewhere
  // (variant B leaked the word "contradict" into the control sample
  // during the diagnostic).
  if (hotRefs.length > 0) {
    lines.push(
      "⛔ DO NOT propose any `delete` operation for these refs — they are user-explicit (captureMode: hot) and the downstream guard refuses them regardless. Proposing delete for any of these only wastes tokens.",
    );
    for (const ref of hotRefs) lines.push(`  - ${ref}`);
    lines.push("");
  }

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    const { isHot, isAlreadyQueued, body } = annotationsByIndex[i];

    const annotations: string[] = [];
    if (isHot) annotations.push("captureMode: hot");
    if (isAlreadyQueued) annotations.push("already queued");
    const annotationSuffix = annotations.length > 0 ? ` (${annotations.join("; ")})` : "";

    lines.push(`[${i + 1}] memory:${m.name}${annotationSuffix}`);
    lines.push(`Description: ${m.description || "(none)"}`);
    lines.push(`Tags: ${m.tags.length > 0 ? m.tags.join(", ") : "(none)"}`);
    lines.push("---");
    lines.push(body.slice(0, bodyTruncation));
    lines.push("");
  }
  return lines.join("\n");
}
