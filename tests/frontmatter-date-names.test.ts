// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Date-valued frontmatter keys have bare names (`observed`, `started`, `ended`),
 * like `created`, `updated` and `expires`. Readers take the new name first and
 * fall back to the old `_at` spelling; writers write only the new name.
 */
import { describe, expect, test } from "bun:test";
import { buildSessionAssetContent } from "../src/commands/improve/session-asset";
import { buildMemoryFrontmatter, parseEnrichObserved } from "../src/commands/remember";
import { parseFrontmatter, readFrontmatterDate } from "../src/core/asset/frontmatter";
import type { SessionData } from "../src/integrations/session-logs/types";

describe("readFrontmatterDate", () => {
  test("the new name wins over the old one", () => {
    expect(readFrontmatterDate({ observed: "2026-05-01", observed_at: "2026-04-20" }, "observed")).toBe("2026-05-01");
  });

  test("an old name alone still works", () => {
    expect(readFrontmatterDate({ observed_at: " 2026-04-20 " }, "observed")).toBe("2026-04-20");
    expect(readFrontmatterDate({ started_at: "s", ended_at: "e" }, "started")).toBe("s");
    expect(readFrontmatterDate({ started_at: "s", ended_at: "e" }, "ended")).toBe("e");
  });

  test("a blank new name falls back to the old one, and neither is undefined", () => {
    expect(readFrontmatterDate({ observed: "  ", observed_at: "2026-04-20" }, "observed")).toBe("2026-04-20");
    expect(readFrontmatterDate({}, "observed")).toBeUndefined();
  });
});

describe("writers emit only the new name", () => {
  test("remember writes `observed`", () => {
    const fm = parseFrontmatter(buildMemoryFrontmatter({ tags: ["ops"], observed_at: "2026-04-24" })).data;
    expect(fm.observed).toBe("2026-04-24");
    expect(fm).not.toHaveProperty("observed_at");
  });

  test("a session asset writes `started` and `ended`", () => {
    const data: SessionData = {
      ref: {
        harness: "claude",
        sessionId: "s-12345678",
        filePath: "/tmp/s.jsonl",
        startedAt: 1_790_000_000_000,
        endedAt: 1_790_000_600_000,
      },
      events: [],
      inlineRefs: [],
    };
    const { frontmatter, content } = buildSessionAssetContent(data, { summary: "Did work.", keyTopics: [] });
    expect(frontmatter.started).toBe(new Date(1_790_000_000_000).toISOString());
    expect(frontmatter.ended).toBe(new Date(1_790_000_600_000).toISOString());
    const written = parseFrontmatter(content).data;
    expect(written).not.toHaveProperty("started_at");
    expect(written).not.toHaveProperty("ended_at");
    expect(written.started).toBe(frontmatter.started);
  });
});

describe("remember --enrich parser", () => {
  test("accepts `observed` and the older `observed_at`, the new name first", () => {
    expect(parseEnrichObserved({ observed: "2026-04-24" })).toBe("2026-04-24");
    expect(parseEnrichObserved({ observed_at: "2026-04-24" })).toBe("2026-04-24");
    expect(parseEnrichObserved({ observed: "2026-05-01", observed_at: "2026-04-24" })).toBe("2026-05-01");
  });

  test("ignores anything that is not a plain YYYY-MM-DD", () => {
    expect(parseEnrichObserved({ observed: "yesterday", observed_at: "2026-04-24" })).toBe("2026-04-24");
    expect(parseEnrichObserved({ observed: "yesterday" })).toBeUndefined();
    expect(parseEnrichObserved({})).toBeUndefined();
  });
});
