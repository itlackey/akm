// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental.memoryEnrichment`: reflect also proposes a memory's `tags`, the replacement for `akm remember --enrich`.
 * The model's reply is read by the function `--enrich` uses (`parseEnrichTags`).
 * This module holds the rest of what reflect and the proactive lane need.
 */

import { serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter, replaceFrontmatterBlocks } from "../../core/asset/frontmatter";
import type { AssetRef } from "../../core/asset/resolve-ref";
import { lookupAsset } from "../../core/assets/read";
import type { AkmConfig } from "../../core/config/config";
import { isMemoryEnrichmentEnabled } from "../../core/config/experimental";
import { appendEvent } from "../../core/events";
import type { AkmReflectResult, ImproveEligibleRef } from "../../core/improve-types";
import type { noticeSet } from "../../execution/notices";
import type { RunnerSpec } from "../../integrations/agent/runner";
import type { Judge } from "../../judges/registry";
import { parseEnrichTags } from "../remember";
import type { AkmReflectOptions } from "./reflect";
import {
  boundedDocument,
  judgeQuality,
  mintProposal,
  QUALITY_VERDICT_SHAPE,
  type QualityJudgeChat,
  type QualityJudgeOptions,
  type QualityJudgeResult,
  resolveQualityGateJudge,
  runQualityJudge,
} from "./stage";

/** The patch fields of a memory under enrichment, after the three every asset has. */
export const ENRICHED_PATCH_FIELDS = ["tags"] as const;

/** A memory's tags are missing: none, or an empty list. */
function untagged(tags: unknown): boolean {
  return Array.isArray(tags) ? tags.length === 0 : !tags;
}

/** Reflect also fills this asset's tags: a memory that has none, with the setting on. */
export function enrichesMemory(
  config: AkmConfig,
  parsedRef: AssetRef | undefined,
  assetContent: string | undefined,
): boolean {
  return (
    isMemoryEnrichmentEnabled(config) &&
    parsedRef?.type === "memory" &&
    untagged(parseFrontmatter(assetContent ?? "").data.tags)
  );
}

/** The reply schema with `tags` added to its `frontmatterPatch`. */
export function withEnrichedPatch(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, { required: string[]; properties: Record<string, unknown> }>;
  const patch = properties.frontmatterPatch;
  if (!patch) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      frontmatterPatch: {
        ...patch,
        required: [...patch.required, ...ENRICHED_PATCH_FIELDS],
        properties: {
          ...patch.properties,
          tags: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 },
        },
      },
    },
  };
}

/** The tags a reply's patch carries: 1-5 of them, as the memory has none. */
export function enrichedPatchFields(fields: Record<string, unknown>): { tags: string[] } {
  const tags = parseEnrichTags(fields.tags).map((t) => t.trim());
  if (tags.length === 0 || tags.length > 5) {
    throw new Error("direct reflect frontmatterPatch.tags must be an array of 1-5 tags: the memory has none");
  }
  return { tags };
}

function isUntaggedMemory(ref: ImproveEligibleRef): boolean {
  const asset = ref.type === "memory" ? lookupAsset(ref.ref) : undefined;
  if (!asset) return false;
  return untagged(asset.entry.frontmatter()?.tags);
}

/** The proactive lane's first-in-line test: untagged memories, with the setting on; otherwise none. */
export function untaggedMemoriesFirst(config: AkmConfig): ((ref: ImproveEligibleRef) => boolean) | undefined {
  return isMemoryEnrichmentEnabled(config) ? isUntaggedMemory : undefined;
}

/** What the tags step reads of reflect's run. */
interface MemoryTagsRun {
  options: AkmReflectOptions;
  stash: string;
  config: AkmConfig;
  engineName: string;
  notices: ReturnType<typeof noticeSet>;
}

/**
 * The tags reflect's reply carried for a memory that has none, as a proposal of their own: judged by the tags judge
 * (`memory.tags`), not reflect's revision judge, and minted apart from the revision, so neither sinks the other.
 */
export async function proposeMemoryTags(args: {
  run: MemoryTagsRun;
  ref: string;
  memory: string;
  tags: string[];
  confidence: number;
  durationMs: number;
  judge: { enabled: boolean; skippedNoJudge: boolean; runner: RunnerSpec | undefined };
}): Promise<AkmReflectResult> {
  const { run, ref, memory, tags, judge } = args;
  const { options } = run;
  const tagLines = serializeFrontmatter({ tags }).split("\n");
  const content =
    replaceFrontmatterBlocks(memory, ["tags"], tagLines) ?? `---\n${tagLines.join("\n")}\n---\n\n${memory}`;
  const verdict = judge.enabled
    ? await runMemoryTagsJudge(run.config, memory, tags, options.chat, {
        runnerSelectionFrozen: true,
        ...(judge.runner ? { llmRunner: judge.runner } : {}),
        ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onNotices: run.notices.add,
      })
    : undefined;
  const event = (metadata: Record<string, unknown>) =>
    appendEvent(
      { eventType: "reflect_completed", ref, metadata: { source: "reflect", tags: true, ...metadata } },
      options.eventsCtx,
    );
  if (verdict && !verdict.pass && !verdict.reviewNeeded) {
    event({ qualityRejected: true, qualityScore: verdict.score, qualityReason: verdict.reason });
    return {
      schemaVersion: 2,
      ok: false,
      reason: "quality_rejected",
      error: `Memory tags quality gate rejected: score=${verdict.score}, reason="${verdict.reason}"`,
      ref,
      engine: run.engineName,
      exitCode: 0,
    };
  }
  // No verdict (an error or timeout, score -1) or an uncertain one: a person decides, as for a revision.
  const judgeFailed = verdict?.reviewNeeded === true && verdict.score === -1;
  const reviewReasons = [
    ...(judge.skippedNoJudge ? ["no-judge-configured"] : []),
    ...(verdict?.reviewNeeded ? [judgeFailed ? "judge-error" : "judge-uncertain"] : []),
  ];
  const proposal = mintProposal(
    run.stash,
    options.ctx,
    {
      ref,
      ...(options.target ? { target: options.target } : {}),
      source: "reflect",
      sourceRun: `reflect-${Date.now()}`,
      payload: { content, frontmatter: parseFrontmatter(content).data },
      confidence: args.confidence,
      ...(options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {}),
      ...(options.itemRef ? { itemRef: options.itemRef, attemptedRefs: [options.itemRef] } : {}),
    },
    reviewReasons.length > 0
      ? {
          review: {
            reason: reviewReasons.join("+"),
            gate: verdict?.reviewNeeded ? "quality-gate" : "reflect",
            ...(verdict?.reviewNeeded && verdict.criteria ? { scores: verdict.criteria } : {}),
            ...(verdict?.reviewNeeded ? { judgeReason: verdict.reason } : {}),
          },
        }
      : { judged: verdict },
  );
  event({ proposalId: proposal.id, engine: run.engineName });
  return {
    schemaVersion: 2,
    ok: true,
    proposal,
    ref: proposal.ref,
    engine: run.engineName,
    durationMs: args.durationMs,
  };
}

export interface MemoryTagsJudgeInput {
  /** The memory, which has no tags. */
  memory: string;
  /** The tags proposed for it. */
  tags: string[];
}

const MEMORY_TAGS_JUDGE_CRITERIA = ["relevance", "usefulness"] as const;

/** The tags judge's prompt: tags for a memory that has none, which akm asked for. */
export function buildMemoryTagsJudgePrompt(memory: string, tags: string[]): string {
  return [
    "You are judging the tags proposed for a memory that has none. akm asked for them, so adding tags is the requested change, not a fault; nothing else in the memory changes.",
    "",
    "Score the tags on each criterion from 1 (poor) to 5 (excellent):",
    "1. RELEVANCE: Does every tag name something the memory is about? Score 1-2 when any tag names a topic the memory does not cover.",
    "2. USEFULNESS: Would someone looking for this memory search for these tags? Score 4-5 for specific terms the memory is about (a product, component, error, tool or technique). Score 1-2 when the tags are only generic words such as `note`, `memory`, `info` or `bug`.",
    "",
    "Memory:",
    "```",
    boundedDocument(memory),
    "```",
    "",
    "Proposed tags:",
    "```",
    tags.join(", "),
    "```",
    "",
    'Return ONLY valid JSON, no prose: {"scores": {"relevance": <1-5 integer>, "usefulness": <1-5 integer>}, "reason": "<one sentence>"}',
  ].join("\n");
}

/** The judge of a memory's tags (`experimental.memoryEnrichment`), apart from reflect's revision judge. */
export const memoryTagsJudge: Judge<MemoryTagsJudgeInput, QualityJudgeResult> = {
  name: "memory.tags",
  description: "The tags judge: are the tags proposed for an untagged memory about it, and useful to find it by.",
  schemaVersion: 1,
  inputSchema: {
    type: "object",
    required: ["memory", "tags"],
    additionalProperties: false,
    properties: { memory: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
  },
  outputSchema: QUALITY_VERDICT_SHAPE,
  harnessReads: "Nothing: the memory is in the prompt.",
  defaultRunner: (config, run) => resolveQualityGateJudge(config, undefined, "reflect", undefined, run),
  run: (input, call) =>
    judgeQuality(buildMemoryTagsJudgePrompt(input.memory, input.tags), MEMORY_TAGS_JUDGE_CRITERIA, call),
};

/** Judge the tags proposed for an untagged memory. */
export function runMemoryTagsJudge(
  config: AkmConfig,
  memory: string,
  tags: string[],
  chat: QualityJudgeChat | undefined,
  options: QualityJudgeOptions = {},
): Promise<QualityJudgeResult> {
  return runQualityJudge(memoryTagsJudge, "proposal_quality_gate", config, { memory, tags }, chat, options);
}
