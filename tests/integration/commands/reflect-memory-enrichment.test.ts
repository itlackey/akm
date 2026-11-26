/**
 * `experimental.memoryEnrichment`: reflect also asks for the `tags` of a memory that has none, and proposes them on their
 * own, judged by the tags judge, apart from its revision. Off (the default) the prompt, the reply schema and the patch contract are exactly as before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmReflect } from "../../../src/commands/improve/reflect";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../../src/core/config/config";
import type { AkmReflectResult } from "../../../src/core/improve-types";
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

/** The frontmatter of the tags proposal a reflect result carries. */
function tagsOf(result: AkmReflectResult): Record<string, unknown> {
  if (!result.tags?.ok) throw new Error(`no tags proposal: ${JSON.stringify(result.tags ?? result)}`);
  return parseFrontmatter(result.tags.proposal.payload.content).data;
}

/** The test config with reflect's quality gate on, judged through the same connection. */
function gated(): AkmConfig {
  const cfg = config(true);
  return {
    ...cfg,
    improve: {
      ...cfg.improve,
      strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } },
    },
  } as AkmConfig;
}

describe("reflect with experimental.memoryEnrichment", () => {
  test("on: asks for tags, never a date, and proposes them on their own for an untagged memory", async () => {
    const { prompt, result } = await reflect("memories/deploy-window", UNTAGGED, config(true), {
      ...ENRICHED_NULL_PATCH,
      tags: ["deploy", " schedule "],
    });
    expect(prompt).toContain("`description`, `when_to_use`, `title` and `tags`");
    expect(prompt).toContain("a specific term someone would search for");
    expect(prompt).not.toContain("observed");
    // The revision changed nothing; the tags stand apart from it.
    expect(result.ok).toBe(false);
    const fm = tagsOf(result);
    expect(fm.tags).toEqual(["deploy", "schedule"]);
    expect(fm.observed).toBeUndefined();
    expect(fm.description).toBe("Deploy window");
  });

  test("on: a revision and the tags are two proposals, neither carrying the other's change", async () => {
    const { result } = await reflect("memories/deploy-window", UNTAGGED, config(true), {
      ...ENRICHED_NULL_PATCH,
      description: "When the deploy window opens",
      tags: ["deploy"],
    });
    if (!result.ok) throw new Error(result.error);
    const revision = parseFrontmatter(result.proposal.payload.content).data;
    expect(revision.description).toBe("When the deploy window opens");
    expect(revision.tags).toBeUndefined();
    expect(tagsOf(result)).toMatchObject({ description: "Deploy window", tags: ["deploy"] });
    expect(result.tags?.ok && result.tags.proposal.id).not.toBe(result.proposal.id);
  });

  test("on: an untagged memory must get tags: a reply with none is sent back for repair", async () => {
    const { calls, result } = await reflect("memories/deploy-window", UNTAGGED, config(true), ENRICHED_NULL_PATCH, {
      ...ENRICHED_NULL_PATCH,
      tags: ["deploy"],
    });
    expect(calls).toBe(2);
    expect(tagsOf(result).tags).toEqual(["deploy"]);
  });

  test("on, with the quality gate: the tags have their own judge, so a refused revision keeps them", async () => {
    const prompts: string[] = [];
    const result = await akmReflect({
      ref: "memories/deploy-window",
      stashDir: storage.stashDir,
      config: gated(),
      assetContent: UNTAGGED,
      chat: async (_connection, messages) => {
        const prompt = messages.map((m) => m.content).join("\n");
        prompts.push(prompt);
        if (prompt.includes("Score this revision"))
          return JSON.stringify({
            scores: { need: 1, preservation: 2, quality: 3 },
            reason: "rewrites a sound description",
          });
        if (prompt.includes("Proposed tags:"))
          return JSON.stringify({ scores: { relevance: 5, usefulness: 4 }, reason: "the tags name the topic" });
        return JSON.stringify({
          confidence: 0.9,
          frontmatterPatch: { ...ENRICHED_NULL_PATCH, description: "Deploy days", tags: ["deploy"] },
        });
      },
    });
    const tagsPrompt = prompts.find((p) => p.includes("Proposed tags:")) ?? "";
    expect(tagsPrompt).toContain("akm asked for them");
    expect(tagsPrompt).not.toContain("PRESERVATION");
    expect(prompts.find((p) => p.includes("Score this revision"))).not.toContain("deploy\n");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("the revision should be refused");
    expect(result.reason).toBe("quality_rejected");
    expect(tagsOf(result).tags).toEqual(["deploy"]);
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
