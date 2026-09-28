// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #722 — a reflect rewrite must not make its asset worse for the queries that
 * actually retrieve it. The gate grades the old and the new content, one query
 * at a time, with the retrieval-eval judge's prompt.
 */

import { describe, expect, test } from "bun:test";
import { runRetrievalRegressionGate, usableRetrievalQueries } from "../../../src/commands/improve/retrieval-gate";
import type { LlmRunner } from "../../../src/commands/improve/stage";
import type { ChatMessage } from "../../../src/llm/client";

const runner = {
  kind: "llm",
  engine: "judge",
  connection: { endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "judge-model" },
} as unknown as LlmRunner;

const OLD = "---\ndescription: Old description\n---\n\nOLD_BODY explains how to rotate the VPN key.\n";
const NEW = "---\ndescription: New description\n---\n\nNEW_BODY talks about something else.\n";

/** A judge that grades by which body it is shown, and records every prompt. */
function judge(grades: { old: number; new: number }, seen: ChatMessage[][] = []) {
  return async (_connection: unknown, messages: ChatMessage[]) => {
    seen.push(messages);
    const user = messages.at(-1)?.content ?? "";
    const grade = user.includes("OLD_BODY") ? grades.old : grades.new;
    return JSON.stringify({ grade, reason: "graded" });
  };
}

const base = { ref: "knowledge/vpn-rotation", before: OLD, after: NEW, runner };

describe("runRetrievalRegressionGate", () => {
  test("refuses a rewrite that grades lower on the asset's own queries", async () => {
    const verdict = await runRetrievalRegressionGate({
      ...base,
      queries: ["rotate the vpn key", "vpn key rotation steps"],
      chat: judge({ old: 3, new: 1 }),
    });
    expect(verdict.pass).toBe(false);
    expect(verdict).toMatchObject({ oldMean: 3, newMean: 1, queries: 2 });
    expect(verdict.reason).toContain("retrieval");
  });

  test("passes a rewrite that grades the same or higher", async () => {
    for (const grades of [
      { old: 2, new: 2 },
      { old: 1, new: 3 },
    ]) {
      const verdict = await runRetrievalRegressionGate({
        ...base,
        queries: ["rotate the vpn key"],
        chat: judge(grades),
      });
      expect(verdict.pass).toBe(true);
    }
  });

  test("without retrieval queries there is nothing to compare, so the rewrite passes unjudged", async () => {
    const seen: ChatMessage[][] = [];
    const verdict = await runRetrievalRegressionGate({ ...base, queries: [], chat: judge({ old: 3, new: 0 }, seen) });
    expect(verdict).toMatchObject({ pass: true, queries: 0 });
    expect(seen).toHaveLength(0);
  });

  test("grades each version blind with the calibrated relevance prompt", async () => {
    const seen: ChatMessage[][] = [];
    await runRetrievalRegressionGate({
      ...base,
      queries: ["rotate the vpn key"],
      chat: judge({ old: 2, new: 2 }, seen),
    });
    expect(seen).toHaveLength(2);
    for (const messages of seen) {
      expect(messages[0]?.content).toContain("3 = exactly the asset an agent should load");
      const user = messages.at(-1)?.content ?? "";
      expect(user).toContain("Query: rotate the vpn key");
      expect(user).toContain("Ref: knowledge/vpn-rotation");
      expect(user).not.toContain("---");
    }
    const users = seen.map((messages) => messages.at(-1)?.content ?? "");
    expect(users.some((user) => user.includes("Description: Old description"))).toBe(true);
    expect(users.some((user) => user.includes("Description: New description"))).toBe(true);
  });

  test("fails closed when a grade cannot be read", async () => {
    const verdict = await runRetrievalRegressionGate({
      ...base,
      queries: ["rotate the vpn key"],
      chat: async () => "not json",
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("could not");
  });
});

describe("usableRetrievalQueries", () => {
  test("drops harness envelopes, the stash README line and pastes, keeps five distinct queries", () => {
    const queries = usableRetrievalQueries([
      "  rotate   the vpn key ",
      "rotate the vpn key",
      "<task-notification>done</task-notification>",
      "This is an **AKM stash** — a structured knowledge repository that stores reusable",
      "x".repeat(2001),
      "q1",
      "q2",
      "q3",
      "q4",
      "q5",
    ]);
    expect(queries).toEqual(["rotate the vpn key", "q1", "q2", "q3", "q4"]);
  });
});
