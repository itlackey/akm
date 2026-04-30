/**
 * Tests for `akm distill <ref>` (#228).
 *
 * The LLM transport is never called for real — `chatCompletion` is provided
 * via the `chat` seam on `akmDistill` so each test pins its own deterministic
 * response. The `lookupFn` and `readEventsFn` seams keep the test from
 * touching the real indexer or events stream.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmDistill, buildDistillPrompt, deriveLessonRef } from "../src/commands/distill";
import type { AkmConfig } from "../src/core/config";
import { readEvents } from "../src/core/events";
import { listProposals } from "../src/core/proposals";
import { LlmFeatureTimeoutError } from "../src/llm/feature-gate";

// ── Test scaffolding ────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-distill-stash-");
  for (const dir of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

function configAbsentFeature(stashDir: string): AkmConfig {
  // No `features` block at all → gate defaults to false per spec §14.
  return {
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    llm: { endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" },
  } as AkmConfig;
}

function configEnabled(stashDir: string): AkmConfig {
  return {
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    llm: {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "test-model",
      features: { feedback_distillation: true },
    },
  } as AkmConfig;
}

function configDisabled(stashDir: string): AkmConfig {
  return {
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    llm: {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "test-model",
      features: { feedback_distillation: false },
    },
  } as AkmConfig;
}

const VALID_LESSON = `---
description: Prefer ripgrep over grep on large repos
when_to_use: Searching for symbols across a multi-thousand-file repo
---

Use \`rg\` instead of \`grep -r\`. It is faster and respects \`.gitignore\` by default.
`;

const INVALID_LESSON_MISSING_WHEN = `---
description: Use ripgrep
---

Body without when_to_use.
`;

const noopLookup = async () => null;
const emptyEvents = (() => ({ events: [], nextOffset: 0 })) as unknown as typeof readEvents;

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-distill-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-distill-config-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("deriveLessonRef", () => {
  test("strips origin and lower-cases the slug", () => {
    expect(deriveLessonRef("skill:Deploy")).toBe("lesson:skill-deploy-lesson");
    expect(deriveLessonRef("team//memory:auth-tips")).toBe("lesson:memory-auth-tips-lesson");
  });

  test("collapses unsafe characters into single dashes", () => {
    expect(deriveLessonRef("knowledge:foo bar.baz")).toBe("lesson:knowledge-foo-bar-baz-lesson");
  });

  test("rejects malformed input refs", () => {
    expect(() => deriveLessonRef("not-a-ref")).toThrow();
  });
});

describe("buildDistillPrompt", () => {
  test("includes asset content when present", () => {
    const prompt = buildDistillPrompt({
      inputRef: "skill:deploy",
      assetContent: "deploy stuff",
      feedback: [],
    });
    expect(prompt).toContain("Asset ref: skill:deploy");
    expect(prompt).toContain("deploy stuff");
    expect(prompt).toContain("(no feedback events recorded");
  });

  test("falls back gracefully when asset is not indexed", () => {
    const prompt = buildDistillPrompt({ inputRef: "skill:deploy", assetContent: null, feedback: [] });
    expect(prompt).toContain("(asset is not currently indexed");
  });

  test("formats feedback events compactly", () => {
    const prompt = buildDistillPrompt({
      inputRef: "skill:deploy",
      assetContent: null,
      feedback: [{ ts: "2026-04-27T00:00:00Z", eventType: "feedback", metadata: { signal: "negative" } }],
    });
    expect(prompt).toContain('2026-04-27T00:00:00Z feedback {"signal":"negative"}');
  });
});

// ── Acceptance: gate disabled ───────────────────────────────────────────────

describe("akmDistill — feature gate", () => {
  test("absent feature flag → outcome 'skipped', exit 0, no proposal, event emitted", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configAbsentFeature(stash),
      stashDir: stash,
      chat: async () => {
        throw new Error("chat must not be called when gate is disabled");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("skipped");
    expect(result.proposalId).toBeUndefined();
    expect(listProposals(stash)).toEqual([]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.length).toBe(1);
    expect(events[0].metadata?.outcome).toBe("skipped");
  });

  test("explicit `feedback_distillation: false` → also skipped", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configDisabled(stash),
      stashDir: stash,
      chat: async () => {
        throw new Error("chat must not be called when gate is disabled");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("skipped");
    expect(listProposals(stash)).toEqual([]);
  });
});

// ── Acceptance: LLM throws ──────────────────────────────────────────────────

describe("akmDistill — LLM error paths", () => {
  test("chat throws → graceful skipped outcome, no proposal, event emitted", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => {
        throw new Error("network down");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("skipped");
    expect(result.proposalId).toBeUndefined();
    expect(listProposals(stash)).toEqual([]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.at(-1)?.metadata?.outcome).toBe("skipped");
  });

  test("chat returns empty string → also skipped", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => "   ",
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("skipped");
    expect(listProposals(stash)).toEqual([]);
  });

  test("simulated timeout → handled like an error and falls back to skipped", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => {
        // The wrapper only wraps tryLlmFeature's own timer, but the chat seam
        // throwing a timeout-shaped error is observably the same path.
        throw new LlmFeatureTimeoutError("feedback_distillation", 30_000);
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("skipped");
    expect(listProposals(stash)).toEqual([]);
  });

  test("no `llm` block configured at all → gate is closed, outcome skipped", async () => {
    const stash = makeStashDir();
    const config = {
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
      // Intentionally no `llm` block — gate cannot read `features`, defaults
      // to false per spec §14.
    } as AkmConfig;
    const result = await akmDistill({
      ref: "skill:deploy",
      config,
      stashDir: stash,
      chat: async () => {
        throw new Error("chat must not be called when llm is absent");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("skipped");
    expect(listProposals(stash)).toEqual([]);
  });
});

// ── Acceptance: validation failure ──────────────────────────────────────────

describe("akmDistill — validation failure", () => {
  test("LLM returns lesson missing `when_to_use` → throws, no proposal, event emitted", async () => {
    const stash = makeStashDir();
    let threw: Error | undefined;
    try {
      await akmDistill({
        ref: "skill:deploy",
        config: configEnabled(stash),
        stashDir: stash,
        chat: async () => INVALID_LESSON_MISSING_WHEN,
        lookupFn: noopLookup,
        readEventsFn: emptyEvents,
      });
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).toBeInstanceOf(Error);
    expect(threw?.message).toContain("when_to_use");
    expect(listProposals(stash)).toEqual([]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.at(-1)?.metadata?.outcome).toBe("validation_failed");
  });
});

// ── Acceptance: queued ──────────────────────────────────────────────────────

describe("akmDistill — queued proposal", () => {
  test("LLM returns valid lesson → proposal created, queued event emitted", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
      sourceRun: "run-xyz",
    });

    expect(result.outcome).toBe("queued");
    expect(result.lessonRef).toBe("lesson:skill-deploy-lesson");
    expect(typeof result.proposalId).toBe("string");

    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    expect(proposals[0].source).toBe("distill");
    expect(proposals[0].sourceRun).toBe("run-xyz");
    expect(proposals[0].ref).toBe("lesson:skill-deploy-lesson");
    expect(proposals[0].payload.content).toContain("description: Prefer ripgrep over grep");
    expect(proposals[0].payload.frontmatter?.when_to_use).toBeDefined();

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.length).toBe(1);
    expect(events[0].metadata?.outcome).toBe("queued");
    expect(events[0].metadata?.proposalId).toBe(result.proposalId);
  });

  test("LLM-fenced response is unwrapped before linting", async () => {
    const stash = makeStashDir();
    const fenced = `\`\`\`markdown\n${VALID_LESSON}\n\`\`\``;
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => fenced,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("queued");
    expect(listProposals(stash).length).toBe(1);
  });

  test("asset content from the indexer is included in the prompt", async () => {
    const stash = makeStashDir();
    const skillFile = path.join(stash, "skills", "deploy.md");
    fs.writeFileSync(skillFile, "---\ndescription: deploy\n---\n\nbody\n", "utf8");

    let receivedPrompt = "";
    await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async (_cfg, messages) => {
        receivedPrompt = messages.map((m) => m.content).join("\n");
        return VALID_LESSON;
      },
      lookupFn: async () => skillFile,
      readEventsFn: emptyEvents,
    });
    expect(receivedPrompt).toContain("body");
  });
});

// ── #267: excludeFeedbackFromRefs option ─────────────────────────────────────

describe("akmDistill — excludeFeedbackFromRefs (#267)", () => {
  function eventsFor(ref: string, signals: Array<"positive" | "negative">) {
    return (() => ({
      events: signals.map((s, i) => ({
        schemaVersion: 1 as const,
        id: i,
        ts: `2026-04-27T00:00:0${i}Z`,
        eventType: "feedback",
        ref,
        metadata: { signal: s },
      })),
      nextOffset: 0,
    })) as unknown as typeof readEvents;
  }

  test("filters out events whose ref is in the exclusion list", async () => {
    const stash = makeStashDir();
    let receivedPrompt = "";
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async (_cfg, messages) => {
        receivedPrompt = messages.map((m) => m.content).join("\n");
        return VALID_LESSON;
      },
      lookupFn: noopLookup,
      readEventsFn: eventsFor("skill:deploy", ["negative", "negative", "positive"]),
      excludeFeedbackFromRefs: ["skill:deploy"],
    });
    expect(result.outcome).toBe("queued");
    expect(result.filteredFeedbackCount).toBe(3);
    expect(result.feedbackFullyFiltered).toBe(true);
    // Prompt should NOT contain any of the dropped feedback events.
    expect(receivedPrompt).not.toContain('"signal":"negative"');
    expect(receivedPrompt).not.toContain('"signal":"positive"');
    expect(receivedPrompt).toContain("(no feedback events recorded");
  });

  test("does not filter when the ref is absent from the exclusion list", async () => {
    const stash = makeStashDir();
    let receivedPrompt = "";
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async (_cfg, messages) => {
        receivedPrompt = messages.map((m) => m.content).join("\n");
        return VALID_LESSON;
      },
      lookupFn: noopLookup,
      readEventsFn: eventsFor("skill:deploy", ["negative", "positive"]),
      excludeFeedbackFromRefs: ["memory:other"],
    });
    expect(result.outcome).toBe("queued");
    expect(result.filteredFeedbackCount).toBe(0);
    expect(result.feedbackFullyFiltered).toBe(false);
    expect(receivedPrompt).toContain('"signal":"negative"');
    expect(receivedPrompt).toContain('"signal":"positive"');
  });

  test("empty exclusion list is a no-op (no diagnostic fields stamped)", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: noopLookup,
      readEventsFn: eventsFor("skill:deploy", ["negative"]),
      excludeFeedbackFromRefs: [],
    });
    expect(result.outcome).toBe("queued");
    expect(result.filteredFeedbackCount).toBeUndefined();
    expect(result.feedbackFullyFiltered).toBeUndefined();
  });

  test("feedbackFullyFiltered=false when no events were ever recorded", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
      excludeFeedbackFromRefs: ["skill:deploy"],
    });
    expect(result.outcome).toBe("queued");
    expect(result.filteredFeedbackCount).toBe(0);
    // No events to begin with — this is "no feedback exists", not "we
    // suppressed it all".
    expect(result.feedbackFullyFiltered).toBe(false);
  });

  test("filtered count is recorded on the distill_invoked event metadata", async () => {
    const stash = makeStashDir();
    await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: noopLookup,
      readEventsFn: eventsFor("skill:deploy", ["negative", "negative"]),
      excludeFeedbackFromRefs: ["skill:deploy"],
    });
    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.length).toBe(1);
    expect(events[0].metadata?.filteredFeedbackCount).toBe(2);
  });
});

// ── #284 GAP-MED 3: success envelope shape contract ─────────────────────────

// ── #284 GAP-HIGH 7: feature gate ON but llm config missing ────────────────

describe("akmDistill — feature ON + llm.client missing (#284 HIGH 7)", () => {
  test("feature_distillation: true but no `llm` block → outcome=skipped, no crash", async () => {
    const stash = makeStashDir();
    // Construct a config WITH features enabled but WITHOUT the `llm` block.
    // Validation in parseLlmFeatures requires `llm`; we bypass that by
    // assembling the shape directly (this mimics a partial / racy config).
    const config = {
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
      llm: { features: { feedback_distillation: true } },
    } as unknown as AkmConfig;
    const result = await akmDistill({
      ref: "skill:deploy",
      config,
      stashDir: stash,
      chat: async () => {
        throw new Error("must not be called when llm.endpoint/model missing");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("skipped");
    expect(result.proposalId).toBeUndefined();
    expect(listProposals(stash)).toEqual([]);
  });
});

describe("akmDistill — success envelope shape contract (#284)", () => {
  test("queued result carries the locked field set", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
      sourceRun: "run-shape-contract",
    });
    // Locked envelope keys (v1 §11/§14): ok, outcome, inputRef, lessonRef,
    // proposalId. Queued path additionally carries proposal stub fields via
    // `result.proposal` if present.
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("queued");
    expect(result.inputRef).toBe("skill:deploy");
    expect(result.lessonRef).toBe("lesson:skill-deploy-lesson");
    expect(typeof result.proposalId).toBe("string");
    // schemaVersion present at the top level (v1 spec lock)
    expect((result as unknown as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  test("skipped result preserves the same outer shape but omits proposalId", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configAbsentFeature(stash),
      stashDir: stash,
      chat: async () => {
        throw new Error("must not be called");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("skipped");
    expect(result.proposalId).toBeUndefined();
    expect((result as unknown as { schemaVersion: number }).schemaVersion).toBe(1);
  });
});
