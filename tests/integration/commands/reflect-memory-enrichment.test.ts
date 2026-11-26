/**
 * `experimental.memoryEnrichment`: reflect also sets the `tags` of a memory that has none in its usual
 * patch. Off (the default) the prompt, the reply schema and the patch contract are exactly as before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmReflect } from "../../../src/commands/improve/reflect";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../../src/core/config/config";
import { quietQualityGateConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
});

function config(memoryEnrichment: boolean | undefined): AkmConfig {
  return {
    ...quietQualityGateConfig(),
    harnesses: undefined,
    connections: {
      "test-llm": { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "test-model" } },
    },
    ...(memoryEnrichment === undefined ? {} : { experimental: { memoryEnrichment } }),
  } as AkmConfig;
}

const NULL_PATCH = { description: null, when_to_use: null, title: null };
const ENRICHED_NULL_PATCH = { ...NULL_PATCH, tags: null };
const UNTAGGED = "---\ndescription: Deploy window\n---\n\nThe deploy window moved on 2026-03-04 to Thursdays.\n";

/** Run reflect against `source`, answering with `patch`; returns the prompt it sent and the result. */
async function reflect(ref: string, source: string, cfg: AkmConfig, ...patches: Record<string, unknown>[]) {
  const prompts: string[] = [];
  const result = await akmReflect({
    ref,
    stashDir: storage.stashDir,
    config: cfg,
    assetContent: source,
    chat: async (_connection, messages) => {
      prompts.push(messages.map((m) => m.content).join("\n"));
      const patch = patches[Math.min(prompts.length - 1, patches.length - 1)];
      return JSON.stringify({ confidence: 0.9, frontmatterPatch: patch });
    },
  });
  return { prompt: prompts[0] ?? "", calls: prompts.length, result };
}

describe("reflect with experimental.memoryEnrichment", () => {
  test("on: asks for tags, never a date, and proposes them for an untagged memory", async () => {
    const { prompt, result } = await reflect("memories/deploy-window", UNTAGGED, config(true), {
      ...ENRICHED_NULL_PATCH,
      tags: ["deploy", " schedule "],
    });
    expect(prompt).toContain("`description`, `when_to_use`, `title` and `tags`");
    expect(prompt).not.toContain("observed");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const fm = parseFrontmatter(result.proposal.payload.content).data;
    expect(fm.tags).toEqual(["deploy", "schedule"]);
    expect(fm.observed).toBeUndefined();
    expect(fm.description).toBe("Deploy window");
  });

  test("on: an untagged memory must get tags: a reply with none is sent back for repair", async () => {
    const { calls, result } = await reflect("memories/deploy-window", UNTAGGED, config(true), ENRICHED_NULL_PATCH, {
      ...ENRICHED_NULL_PATCH,
      tags: ["deploy"],
    });
    expect(calls).toBe(2);
    if (!result.ok) throw new Error(result.error);
    expect(parseFrontmatter(result.proposal.payload.content).data.tags).toEqual(["deploy"]);
  });

  test("on: a memory that has tags is asked for the same three fields as before, and keeps its tags", async () => {
    const source = "---\ndescription: Deploy window\ntags: [ops]\nobserved: 2026-01-01\n---\n\nBody.\n";
    const { prompt, result } = await reflect("memories/has-tags", source, config(true), {
      ...NULL_PATCH,
      description: "When the deploy window opens",
    });
    expect(prompt).not.toContain("`tags`");
    if (!result.ok) throw new Error(result.error);
    const fm = parseFrontmatter(result.proposal.payload.content).data;
    expect(fm.tags).toEqual(["ops"]);
    expect(String(fm.observed)).toContain("2026-01-01");
    expect(fm.description).toBe("When the deploy window opens");
  });

  test("on: a reply that carries an observed date is refused", async () => {
    const { result } = await reflect("memories/date", UNTAGGED, config(true), {
      ...ENRICHED_NULL_PATCH,
      tags: ["deploy"],
      observed: "2026-03-04",
    });
    expect(result.ok).toBe(false);
  });

  test("on: a non-memory asset is asked for the same three fields as before", async () => {
    const source = "---\ndescription: Old\nwhen_to_use: Sometimes\n---\n\n# Lesson\n\nBody.\n";
    const { prompt, result } = await reflect("lessons/a-lesson", source, config(true), {
      ...NULL_PATCH,
      description: "A new description",
    });
    expect(prompt).not.toContain("`tags`");
    expect(result.ok).toBe(true);
  });

  for (const [label, cfg] of [
    ["absent", config(undefined)],
    ["false", config(false)],
  ] as const) {
    test(`${label}: the prompt names the three fields only, and a reply with tags is refused`, async () => {
      const { prompt, result } = await reflect("memories/deploy-window", UNTAGGED, cfg, {
        ...ENRICHED_NULL_PATCH,
        tags: ["deploy"],
      });
      expect(prompt).toContain("exactly `description`, `when_to_use` and `title`");
      expect(prompt).not.toContain("`tags`");
      expect(result.ok).toBe(false);
    });
  }
});
