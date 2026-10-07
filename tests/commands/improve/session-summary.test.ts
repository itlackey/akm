// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The session summary's response schema requires every property, as a strict
 * structured-output provider needs, so a summary with no tags says `"tags": []`.
 * The prompt asks for exactly that and `parseSessionSummary` reads it as no tags.
 */
import { describe, expect, test } from "bun:test";
import {
  buildSessionSummaryPrompt,
  parseSessionSummary,
  SESSION_SUMMARY_JSON_SCHEMA,
} from "../../../src/commands/improve/session-asset";
import type { SessionData } from "../../../src/integrations/session-logs/types";

const data: SessionData = {
  ref: { harness: "claude", sessionId: "s-1", filePath: "/tmp/s-1.jsonl", title: "Indexer work" },
  events: [{ harness: "claude", role: "user", text: "Why is the FTS table scoring differently?" }],
  inlineRefs: [],
};

describe("the session summary a strict provider returns", () => {
  test("asks for every property, `tags` included, and says what an empty one means", () => {
    expect(SESSION_SUMMARY_JSON_SCHEMA.required).toEqual(["summary", "key_topics", "tags"]);
    expect(buildSessionSummaryPrompt(data)).toContain(
      'Respond as JSON: {"summary": string, "key_topics": string[], "tags": string[]} (an empty array for no tags).',
    );
  });

  test("an empty tags array is no tags", () => {
    const parsed = parseSessionSummary(
      JSON.stringify({ summary: "Traced the FTS totals.", key_topics: ["fts", "bm25"], tags: [] }),
    );
    expect(parsed).toEqual({ summary: "Traced the FTS totals.", keyTopics: ["fts", "bm25"] });
    expect(parsed).not.toHaveProperty("tags");
  });

  test("tags the model gave are kept, blank ones dropped", () => {
    expect(
      parseSessionSummary(
        JSON.stringify({ summary: "Traced the FTS totals.", key_topics: [], tags: ["fts", " ", "bm25"] }),
      ),
    ).toEqual({ summary: "Traced the FTS totals.", keyTopics: [], tags: ["fts", "bm25"] });
  });
});
