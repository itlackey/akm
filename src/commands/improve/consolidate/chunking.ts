// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Consolidate's chunk sizing and per-chunk prompt (pure token math and text). */

import fs from "node:fs";
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import type { MemoryEntry } from "../consolidate";
import { contentHash, stripFrontmatterBody } from "../content-hash";

/** A conservative chars-per-token estimate, shared by every context-length budget. */
export const CHARS_PER_TOKEN = 3;

/** System prompt, headers and per-memory metadata, with room for the output. */
const PROMPT_OVERHEAD_TOKENS = 2_000;

/**
 * The budget when the engine sets no `contextLength`. Conservative on purpose:
 * an agent CLI prepends its own large prompt; set `contextLength` on a direct
 * LLM engine to allow bigger chunks.
 */
export const DEFAULT_CONTEXT_LENGTH_TOKENS = 4_096;

/** Memories per chunk: `(contextLength − overhead) / ceil(bodyTruncation / CHARS_PER_TOKEN)`, within 1…cap (50). */
export function computeSafeChunkSize(contextLength: number, bodyTruncation: number, maxChunkSize?: number): number {
  const usableTokens = Math.max(contextLength - PROMPT_OVERHEAD_TOKENS, 0);
  const tokensPerMemory = Math.max(Math.ceil(bodyTruncation / CHARS_PER_TOKEN), 1);
  return Math.max(1, Math.min(maxChunkSize ?? 50, Math.floor(usableTokens / tokensPerMemory)));
}

/**
 * One chunk's user prompt. Each memory shows its body only (frontmatter can
 * outrun the truncation and leave the model judging metadata), marked
 * `captureMode: hot` when the user captured it explicitly and `already queued`
 * when a pending consolidate proposal carries its body hash — the system
 * prompt forbids promoting those.
 */
export function buildChunkPrompt(
  sourceName: string,
  memories: MemoryEntry[],
  chunkIndex: number,
  totalChunks: number,
  bodyTruncation: number,
  pendingProposalBodyHashes: Set<string> = new Set(),
): string {
  const lines: string[] = [
    `Source: ${sourceName}`,
    `Chunk ${chunkIndex + 1} of ${totalChunks} (${memories.length} memories):`,
    "",
  ];
  memories.forEach((m, i) => {
    let body: string;
    try {
      body = fs.readFileSync(m.filePath, "utf8");
    } catch {
      body = "(unreadable)";
    }
    const annotations: string[] = [];
    if (parseFrontmatter(body).data.captureMode === "hot") annotations.push("captureMode: hot");
    if (pendingProposalBodyHashes.has(contentHash(body, "body"))) annotations.push("already queued");
    const annotationSuffix = annotations.length > 0 ? ` (${annotations.join("; ")})` : "";
    lines.push(
      `[${i + 1}] memories/${m.name}${annotationSuffix}`,
      `Description: ${m.description || "(none)"}`,
      `Tags: ${m.tags.length > 0 ? m.tags.join(", ") : "(none)"}`,
      "---",
      stripFrontmatterBody(body).slice(0, bodyTruncation),
      "",
    );
  });
  return lines.join("\n");
}
