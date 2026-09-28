// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The retrieval regression gate (#722): a reflect rewrite of an existing asset
 * must not grade lower on the queries that actually retrieved it.
 *
 * Measured before it was built: of 60 accepted reflect rewrites judged against
 * their own queries, 14 graded lower (23%, 95% CI 14–35%) and 12 higher. The
 * old and new content are graded one query at a time, blind, with the
 * retrieval-eval judge's prompt (kappa 0.83 against human grades) and its
 * document shape: type, ref, name, description and the first 1,500 characters
 * of the body.
 */

import relevanceJudgePrompt from "../../assets/prompts/retrieval-relevance-judge.md" with { type: "text" };
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { parseRefInput } from "../../core/asset/resolve-ref";
import type { LlmConnectionConfig } from "../../core/config/config";
import { nonTaskInput } from "../../core/non-task-input";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { listRetrievalQueries } from "../../indexer/usage/usage-events";
import type { ChatCompletionOptions, ChatMessage } from "../../llm/client";
import { type LedgerAccess, readLedgerDb, stripBundle } from "./ledger";
import { callStage, type LlmRunner, type NoticeSink } from "./stage";

/** Queries graded per rewrite, as measured. */
const MAX_QUERIES = 5;
/** The retrieval suite treats a longer input as a paste, not a query; the measurement did the same. */
const MAX_QUERY_CHARS = 2000;
/** The judge sees this much of the body, as in the retrieval eval. */
const MAX_DOC_CHARS = 1500;

const GRADE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["grade", "reason"],
  additionalProperties: false,
  properties: { grade: { type: "integer", minimum: 0, maximum: 3 }, reason: { type: "string" } },
};

/** Up to five distinct task queries, in the given order, whitespace collapsed. */
export function usableRetrievalQueries(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of raw) {
    const query = text.replace(/\s+/g, " ").trim();
    if (!query || query.length > MAX_QUERY_CHARS || nonTaskInput(query) || out.includes(query)) continue;
    out.push(query);
    if (out.length === MAX_QUERIES) break;
  }
  return out;
}

/** The asset's own retrieval queries from the usage log (none when state.db cannot be read). */
export function loadRetrievalQueries(access: LedgerAccess | undefined, ref: string): string[] {
  try {
    return usableRetrievalQueries(readLedgerDb(access, (db) => listRetrievalQueries(db, stripBundle(ref))) ?? []);
  } catch {
    return [];
  }
}

function judgeDocument(ref: string, raw: string): string {
  const conceptId = stripBundle(ref);
  const parsed = parseRefInput(conceptId);
  const { data, content } = parseFrontmatter(raw);
  const text = content
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_DOC_CHARS);
  const name = typeof data.name === "string" && data.name ? data.name : parsed.name;
  const description = typeof data.description === "string" ? data.description : "";
  return [
    "Candidate asset:",
    `Type: ${parsed.type}`,
    `Ref: ${conceptId}`,
    `Name: ${name}`,
    `Description: ${description}`,
    "",
    "Content:",
    text,
  ].join("\n");
}

type JudgeChat = (
  connection: LlmConnectionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
) => Promise<string>;

export interface RetrievalGateVerdict {
  pass: boolean;
  /** Queries graded (0 when the asset has none: the rewrite passes unjudged). */
  queries: number;
  oldMean?: number;
  newMean?: number;
  reason: string;
}

/**
 * Grade `before` and `after` on each query; refuse the rewrite when the new
 * content's mean grade is lower. Fails closed, like the quality judge: a grade
 * that cannot be obtained refuses the rewrite.
 */
export async function runRetrievalRegressionGate(args: {
  ref: string;
  before: string;
  after: string;
  queries: readonly string[];
  runner: LlmRunner;
  chat?: JudgeChat;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onNotices?: NoticeSink;
}): Promise<RetrievalGateVerdict> {
  if (args.queries.length === 0) return { pass: true, queries: 0, reason: "no retrieval queries to compare on" };
  const documents = { old: judgeDocument(args.ref, args.before), new: judgeDocument(args.ref, args.after) };
  const totals = { old: 0, new: 0 };
  for (const query of args.queries) {
    for (const version of ["old", "new"] as const) {
      const outcome = await callStage({
        feature: "proposal_quality_gate",
        runner: args.runner,
        system: relevanceJudgePrompt.trim(),
        prompt: `Query: ${query}\n\n${documents[version]}`,
        request: {
          enableThinking: false,
          temperature: 0,
          responseSchema: GRADE_SCHEMA,
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(args.signal ? { signal: args.signal } : {}),
          ...(args.chat ? { chat: args.chat } : {}),
        },
        ...(args.onNotices ? { onNotices: args.onNotices } : {}),
      });
      const grade = outcome.ok ? parseEmbeddedJsonResponse<{ grade?: unknown }>(outcome.raw)?.grade : undefined;
      if (typeof grade !== "number" || !Number.isInteger(grade) || grade < 0 || grade > 3) {
        return {
          pass: false,
          queries: args.queries.length,
          reason: `retrieval check could not grade the ${version} content${outcome.ok ? "" : ` (${outcome.reason})`}`,
        };
      }
      totals[version] += grade;
    }
  }
  const oldMean = totals.old / args.queries.length;
  const newMean = totals.new / args.queries.length;
  const pass = newMean >= oldMean;
  const grades = `${oldMean.toFixed(2)} -> ${newMean.toFixed(2)} over ${args.queries.length} retrieval ${args.queries.length === 1 ? "query" : "queries"}`;
  return {
    pass,
    queries: args.queries.length,
    oldMean,
    newMean,
    reason: pass ? `retrieval grade ${grades}` : `retrieval regression: grade ${grades}`,
  };
}
