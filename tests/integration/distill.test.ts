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

import {
  akmDistill,
  buildDistillPrompt,
  deriveLessonRef,
  detectDoubleFrontmatter,
  isValidDescription,
  isValidWhenToUse,
} from "../../src/commands/improve/distill";
import { assessMemoryKnowledgePromotionCandidate } from "../../src/commands/improve/distill-promotion-policy";
import { getAssetSalience } from "../../src/commands/improve/salience";
import { listProposals } from "../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../src/core/config/config";
import { readEvents } from "../../src/core/events";
import { openStateDatabase } from "../../src/core/state-db";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../src/indexer/installations";
import { LlmFeatureTimeoutError } from "../../src/llm/feature-gate";

// ── Test scaffolding ────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-distill-stash-");
  for (const dir of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}

/** The durable `proposals.ref` item_ref (WI-8.5a): `<bundle>//<conceptId>`. */
function durableRef(stashDir: string, type: string, name: string): string {
  const bundleId = deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}

function distillConfig(stashDir: string, distill: Record<string, unknown>): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    engines: {
      default: {
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
      },
    },
    improve: { strategies: { test: { processes: { distill } } } },
    defaults: { llmEngine: "default", improveStrategy: "test" },
  } as AkmConfig;
}

function configAbsentFeature(stashDir: string): AkmConfig {
  // No distill process binding → distill defaults to true per 0.8.0. The
  // quality gate is explicitly OFF: these callers exercise the benchmark-scored
  // / merge-resolution mechanics with non-judge chat stubs, and after 07 P0-2
  // the fail-CLOSED gate would otherwise reject them (and its chat call would
  // trip the "chat must not be called" guards).
  return distillConfig(stashDir, { qualityGate: { enabled: false } });
}

function configEnabled(stashDir: string): AkmConfig {
  // Distill mechanics tests exercise the distill path, NOT the LLM-as-judge
  // quality gate. The gate defaults ON in production (`lesson_quality_gate`
  // → distill.qualityGate.enabled ?? true), and after 07 P0-2 it fails CLOSED
  // when the judge can't render a verdict — so a non-judge-aware chat stub
  // would now reject every proposal. Turn the gate OFF here so these tests
  // stay focused on distill mechanics; the dedicated judge tests below use
  // `configJudgeEnabled` and supply real judge verdicts.
  return distillConfig(stashDir, { enabled: true, qualityGate: { enabled: false } });
}

function configJudgeEnabled(stashDir: string): AkmConfig {
  // Distill enabled AND the LLM-as-judge quality gate ON — for tests that
  // exercise judge-verdict routing. Callers MUST supply a judge-aware chat
  // stub (returns JSON `{score,reason}` when the prompt asks to "Score this
  // lesson"), or the fail-CLOSED gate (07 P0-2) rejects the proposal.
  return distillConfig(stashDir, { enabled: true, qualityGate: { enabled: true } });
}

function configDisabled(stashDir: string): AkmConfig {
  return distillConfig(stashDir, { enabled: false });
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

const VALID_KNOWLEDGE = `---
description: Durable deploy guidance
sources: [skill:deploy]
---

# Deploy Guidance

Connect the VPN before production deploys.
`;

const noopLookup = async () => null;
const emptyEvents = (() => ({ events: [], nextOffset: 0 })) as unknown as typeof readEvents;

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

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-distill-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-distill-config-");
  process.env.XDG_DATA_HOME = makeTempDir("akm-distill-data-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
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

  test("preserves the scope segment for scope-born lesson output", () => {
    expect(deriveLessonRef("memory:project-a/deploy-vpn")).toBe("lesson:project-a/memory-deploy-vpn-lesson");
  });
});

describe("akmDistill — source-qualified lookup", () => {
  test("qualifies duplicate refs and never writes salience to another source", async () => {
    const selected = makeStashDir();
    const other = makeStashDir();
    const selectedFile = path.join(selected, "skills", "duplicate.md");
    const otherFile = path.join(other, "skills", "duplicate.md");
    const selectedContent = "---\ndescription: Selected source\n---\n\nSelected source body.\n";
    const otherContent = "---\ndescription: Other source\n---\n\nOther source body.\n";
    fs.writeFileSync(selectedFile, selectedContent, "utf8");
    fs.writeFileSync(otherFile, otherContent, "utf8");
    const lookedUp: string[] = [];

    await akmDistill({
      ref: "skill:duplicate",
      sourceName: "team",
      stashDir: selected,
      config: configEnabled(selected),
      lookupFn: async (ref) => {
        lookedUp.push(ref);
        return ref === "team//skill:duplicate" ? selectedFile : otherFile;
      },
      readEventsFn: emptyEvents,
      chat: async () => VALID_LESSON,
    });

    expect(lookedUp[0]).toBe("team//skill:duplicate");
    expect(fs.readFileSync(selectedFile, "utf8")).toContain("salience:");
    expect(fs.readFileSync(otherFile, "utf8")).toBe(otherContent);
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

  test("D-3: negative signal feedback goes into '## What failed' section", () => {
    const prompt = buildDistillPrompt({
      inputRef: "skill:deploy",
      assetContent: null,
      feedback: [
        {
          ts: "2026-04-27T00:00:00Z",
          eventType: "feedback",
          metadata: { signal: "negative", reason: "Missed the rollback step" },
        },
      ],
    });
    expect(prompt).toContain("## What failed");
    expect(prompt).toContain("Missed the rollback step");
    expect(prompt).not.toContain("## What worked");
  });

  test("D-3: positive signal feedback goes into '## What worked' section", () => {
    const prompt = buildDistillPrompt({
      inputRef: "skill:deploy",
      assetContent: null,
      feedback: [
        {
          ts: "2026-04-27T00:00:00Z",
          eventType: "feedback",
          metadata: { signal: "positive", note: "Deploy succeeded first try" },
        },
      ],
    });
    expect(prompt).toContain("## What worked");
    expect(prompt).toContain("Deploy succeeded first try");
    expect(prompt).not.toContain("## What failed");
  });

  test("D-3: mixed signals produce both What-worked and What-failed sections", () => {
    const prompt = buildDistillPrompt({
      inputRef: "skill:deploy",
      assetContent: null,
      feedback: [
        { ts: "2026-04-26T00:00:00Z", eventType: "feedback", metadata: { signal: "positive", reason: "Quick" } },
        { ts: "2026-04-27T00:00:00Z", eventType: "feedback", metadata: { signal: "negative", reason: "Broke prod" } },
      ],
    });
    expect(prompt).toContain("## What worked");
    expect(prompt).toContain("Quick");
    expect(prompt).toContain("## What failed");
    expect(prompt).toContain("Broke prod");
  });

  test("D-3: non-signal events fall back to flat format", () => {
    // When no positive/negative signals are present, fall back to old format.
    const prompt = buildDistillPrompt({
      inputRef: "skill:deploy",
      assetContent: null,
      feedback: [{ ts: "2026-04-27T00:00:00Z", eventType: "reflect_invoked", metadata: { profile: "test" } }],
    });
    expect(prompt).toContain("Recent feedback events (most recent last):");
    expect(prompt).toContain("reflect_invoked");
    expect(prompt).not.toContain("## What failed");
    expect(prompt).not.toContain("## What worked");
  });

  test("uses knowledge wording when targeting knowledge output", () => {
    const prompt = buildDistillPrompt({
      inputRef: "skill:deploy",
      assetContent: null,
      feedback: [],
      proposalKind: "knowledge",
    });
    expect(prompt).toContain("Produce the knowledge markdown file now.");
    expect(prompt).not.toContain("Produce the lesson markdown file now.");
  });

  test("injects rejected proposals as Reflexion verbal-RL context when present", () => {
    const prompt = buildDistillPrompt({
      inputRef: "skill:deploy",
      assetContent: null,
      feedback: [],
      rejectedProposals: [
        {
          reason: "Too vague, missing concrete examples",
          contentPreview: "---\ndescription: deploy stuff\n---\nBody.",
        },
        { reason: "Duplicate of existing lesson" },
      ],
    });
    expect(prompt).toContain("Previously rejected proposals");
    expect(prompt).toContain("Too vague, missing concrete examples");
    expect(prompt).toContain("Duplicate of existing lesson");
    expect(prompt).toContain("MUST differ meaningfully");
  });

  test("omits rejected proposals section when none provided", () => {
    const prompt = buildDistillPrompt({ inputRef: "skill:deploy", assetContent: null, feedback: [] });
    expect(prompt).not.toContain("Previously rejected proposals");
  });
});

// ── Acceptance: gate disabled ───────────────────────────────────────────────

describe("akmDistill — feature gate", () => {
  // 0.8.0 unified the `feedback_distillation` gate into the `distill` gate
  // and flipped the default to `true` (matches the built-in `default` profile).
  // The "absent feature flag → disabled" test from the legacy gate no longer
  // applies — see `explicit \`distill: false\` → also config_disabled` below
  // and the `configDisabled(...)` helper.

  test("explicit `distill: false` → also config_disabled, NO event emitted", async () => {
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
    expect(result.outcome).toBe("config_disabled");
    expect(listProposals(stash)).toEqual([]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.length).toBe(0);
  });
});

// ── Acceptance: LLM throws ──────────────────────────────────────────────────

describe("akmDistill — LLM error paths", () => {
  test("chat throws → llm_failed outcome, no proposal, event emitted", async () => {
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
    expect(result.outcome).toBe("llm_failed");
    expect(result.message).toContain("LLM call returned no usable output");
    expect(result.proposalId).toBeUndefined();
    expect(listProposals(stash)).toEqual([]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.at(-1)?.metadata?.outcome).toBe("llm_failed");
  });

  test("chat returns empty string → llm_failed (LLM ran but produced nothing)", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => "   ",
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("llm_failed");
    expect(listProposals(stash)).toEqual([]);
  });

  test("simulated timeout → llm_failed (LLM was invoked but timed out)", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => {
        // The wrapper only wraps tryLlmFeature's own timer, but the chat seam
        // throwing a timeout-shaped error is observably the same path.
        throw new LlmFeatureTimeoutError("distill", 30_000);
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("llm_failed");
    expect(listProposals(stash)).toEqual([]);
  });

  test("no `llm` block configured at all → llm_failed (gate is open, but the LLM call has no profile to dispatch to)", async () => {
    const stash = makeStashDir();
    const config = {
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
      // 0.8.0: the distill gate defaults to true; with no llm profile wired,
      // the inner call throws ConfigError(LLM_NOT_CONFIGURED) which the
      // tryLlmFeature wrapper folds into llm_failed.
    } as unknown as AkmConfig;
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
    expect(result.outcome).toBe("llm_failed");
    expect(listProposals(stash)).toEqual([]);
  });
});

// ── Acceptance: Item 1 — distinguish config_disabled from llm_failed ────────
//
// Empirical context: a 108-run audit on release/0.8.0 found 100% of skipped
// outcomes were actually the config-gate-off branch. The previous conflated
// message ("disabled or LLM failed") gave operators no signal to act on, and
// the planner accumulated phantom `distill_invoked` events for invocations
// that never made an LLM call. These two tests pin the new behaviour so the
// signal does not regress.

describe("akmDistill — Item 1: precise gate-off vs LLM-failed outcomes", () => {
  test("explicit distill:false → outcome 'config_disabled', NO distill_invoked event emitted", async () => {
    const stash = makeStashDir();
    // configDisabled wires processes.distill.enabled: false → gate is closed
    // → fallbackReason === "disabled" → suppress event, emit config_disabled.
    let chatCalled = false;
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configDisabled(stash),
      stashDir: stash,
      chat: async () => {
        chatCalled = true;
        return "anything";
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });

    // The LLM must NOT have been called.
    expect(chatCalled).toBe(false);
    // Outcome must precisely identify the cause (config off, not LLM failure).
    expect(result.outcome).toBe("config_disabled");
    expect(result.message).toContain("distill is disabled in config");
    expect(result.message).toContain("enable");
    // CRITICAL: no `distill_invoked` event because no invocation occurred.
    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.length).toBe(0);
  });

  test("gate enabled + LLM returns null → outcome 'llm_failed', event IS emitted", async () => {
    const stash = makeStashDir();
    // configEnabled flips distill: true. The chat seam throws
    // (simulating a transport failure); tryLlmFeature catches it with
    // reason "error" → outcome resolves to llm_failed AND the event fires
    // so the failure is observable on the events stream.
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => {
        throw new Error("simulated upstream LLM error");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });

    expect(result.outcome).toBe("llm_failed");
    expect(result.message).toContain("LLM call returned no usable output");
    // Event MUST be emitted: the LLM was actually invoked.
    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.length).toBe(1);
    expect(events[0].metadata?.outcome).toBe("llm_failed");
  });
});

// ── Acceptance: validation failure ──────────────────────────────────────────

describe("akmDistill — validation failure", () => {
  test("LLM returns lesson missing `when_to_use` AND body has no real trigger → validation_failed (no placeholder fallback)", async () => {
    // Updated for the pipeline-fix sweep: the previous behaviour synthesised a
    // circular `When working with <slug>.` placeholder. That fallback is the
    // root cause of one of the systematic defects observed across 323 archived
    // rejected proposals, so we now refuse to fabricate a when_to_use when no
    // trigger sentence can be extracted from the body. Validation fails cleanly.
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
    expect(listProposals(stash)).toEqual([]);
    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.at(-1)?.metadata?.outcome).toBe("validation_failed");
  });

  test("LLM returns lesson missing `when_to_use` BUT body contains a real 'When …' line → auto-repaired, queued", async () => {
    // Auto-repair still works when there is real trigger prose to harvest.
    const stash = makeStashDir();
    const lesson = `---
description: Always validate the ripgrep installation before running searches across very large monorepos.
---

When searching multi-thousand-file repos, prefer ripgrep to GNU grep — it is faster and respects .gitignore by default.`;
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => lesson,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("queued");
    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    const fm = proposals[0].payload.frontmatter ?? {};
    expect(typeof fm.when_to_use).toBe("string");
    expect((fm.when_to_use as string).toLowerCase()).toContain("when ");
    // Crucially NOT the circular fallback string.
    expect((fm.when_to_use as string).toLowerCase()).not.toContain("when working with");
  });

  test("LLM returns lesson with description leading 'When …' and a valid when_to_use → fields auto-swapped and queued", async () => {
    // Recovery path for qwen-9b's ~50% "DO NOT start with When" prompt
    // non-compliance. When the description leads with When/If but the
    // when_to_use is a valid declarative sentence, the two fields are
    // mis-fielded — `isValidDescription`'s error message itself says the
    // pattern "belongs in when_to_use". The swap normalization commits the
    // swap when revalidation passes and surfaces it via `descriptionSwapped`.
    const stash = makeStashDir();
    const lesson = `---
description: When searching multi-thousand-file repos, prefer ripgrep to GNU grep because it respects .gitignore by default.
when_to_use: Always validate the ripgrep installation before running searches across very large monorepos.
---

Body content explaining why ripgrep wins on large monorepos.`;
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => lesson,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("queued");
    expect(result.descriptionSwapped).toBe(1);
    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    const fm = proposals[0].payload.frontmatter ?? {};
    // After the swap: description should be the declarative sentence,
    // when_to_use should be the conditional one.
    expect((fm.description as string).toLowerCase()).not.toMatch(/^(when|if)\b/);
    expect((fm.when_to_use as string).toLowerCase()).toMatch(/^when\b/);
    expect(fm.description as string).toContain("validate the ripgrep installation");
    expect(fm.when_to_use as string).toContain("multi-thousand-file repos");
    const { events } = readEvents({ type: "distill_invoked" });
    const queuedEvent = events.find((e) => e.metadata?.outcome === "queued");
    expect(queuedEvent?.metadata?.descriptionSwapped).toBe(1);
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
    expect(proposals[0].ref).toBe(durableRef(stash, "lesson", "skill-deploy-lesson"));
    expect(proposals[0].payload.content).toContain("description: Prefer ripgrep over grep");
    expect(proposals[0].payload.frontmatter?.when_to_use).toBeDefined();
    expect(parseFrontmatter(proposals[0].payload.content).data.xrefs).toEqual(["skill:deploy"]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.length).toBe(1);
    expect(events[0].metadata?.outcome).toBe("queued");
    expect(events[0].metadata?.proposalId).toBe(result.proposalId);
  });

  test("injects only the generated lesson type convention into the prompt", async () => {
    const stash = makeStashDir();
    const conventions = path.join(stash, "facts", "conventions", "assets");
    fs.mkdirSync(conventions, { recursive: true });
    fs.writeFileSync(path.join(conventions, "lesson.md"), "---\ncategory: convention\n---\n\nLESSON_ONLY_RULE\n");
    fs.writeFileSync(path.join(conventions, "skill.md"), "---\ncategory: convention\n---\n\nSKILL_ONLY_RULE\n");
    let prompt = "";

    await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async (_config, messages) => {
        prompt = messages.at(-1)?.content ?? "";
        return VALID_LESSON;
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });

    expect(prompt).toContain("LESSON_ONLY_RULE");
    expect(prompt).not.toContain("SKILL_ONLY_RULE");
  });

  test("attribution: eligibilitySource stamps distill_invoked event + proposal record", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
      eligibilitySource: "high-salience",
    });
    expect(result.outcome).toBe("queued");

    // (a) distill_invoked event carries the lane.
    const { events } = readEvents({ type: "distill_invoked" });
    const queued = events.find((e) => e.metadata?.outcome === "queued");
    expect(queued?.metadata?.eligibilitySource).toBe("high-salience");

    // (b) the persisted proposal record carries the lane.
    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    expect(proposals[0].eligibilitySource).toBe("high-salience");
  });

  test("attribution: omitted eligibilitySource leaves distill_invoked + proposal unstamped", async () => {
    const stash = makeStashDir();
    await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    const { events } = readEvents({ type: "distill_invoked" });
    const queued = events.find((e) => e.metadata?.outcome === "queued");
    expect(queued?.metadata?.eligibilitySource).toBeUndefined();
    expect(listProposals(stash)[0].eligibilitySource).toBeUndefined();
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
        // Capture only the FIRST (distill) prompt. (The quality gate is off in
        // configEnabled, so no judge second-call clobbers this — the guard is
        // kept defensively.)
        if (!receivedPrompt) receivedPrompt = messages.map((m) => m.content).join("\n");
        return VALID_LESSON;
      },
      lookupFn: async () => skillFile,
      readEventsFn: emptyEvents,
    });
    expect(receivedPrompt).toContain("body");
  });

  test("reinforced stable memory can queue a knowledge proposal without LLM help", async () => {
    const stash = makeStashDir();
    const memoryFile = path.join(stash, "memories", "deploy-fact.md");
    fs.writeFileSync(
      memoryFile,
      [
        "---",
        "description: VPN required before deploy",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
        "tags: [deploy, ops]",
        "---",
        "",
        "Always connect the VPN before starting production deploys.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await akmDistill({
      ref: "memory:deploy-fact",
      proposalKind: "auto",
      config: configAbsentFeature(stash),
      stashDir: stash,
      chat: async () => {
        throw new Error("chat must not be called for benchmark-scored memory promotion");
      },
      lookupFn: async () => memoryFile,
      readEventsFn: eventsFor("memory:deploy-fact", ["positive", "positive"]),
    });

    expect(result.outcome).toBe("queued");
    expect(result.proposalKind).toBe("knowledge");
    expect(result.lessonRef).toBe("knowledge:deploy-fact");
    expect(result.proposalRef).toBe("knowledge:deploy-fact");

    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ref).toBe(durableRef(stash, "knowledge", "deploy-fact"));
    expect(proposals[0].payload.content).toContain("xrefs:");
    expect(proposals[0].payload.content).toContain("memory:deploy-fact");
    expect(proposals[0].payload.content).toContain("Always connect the VPN");

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events).toHaveLength(1);
    expect(events[0].metadata?.proposalKind).toBe("knowledge");
    expect(events[0].metadata?.proposalRef).toBe("knowledge:deploy-fact");
  });

  test("explicit knowledge mode uses knowledge validation instead of lesson lint", async () => {
    const stash = makeStashDir();
    let receivedPrompt = "";
    const result = await akmDistill({
      ref: "skill:deploy",
      proposalKind: "knowledge",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async (_cfg, messages) => {
        // Capture only the FIRST (distill) prompt. (The quality gate is off in
        // configEnabled, so no judge second-call clobbers this — the guard is
        // kept defensively.)
        if (!receivedPrompt) receivedPrompt = messages.map((m) => m.content).join("\n");
        return VALID_KNOWLEDGE;
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });

    expect(result.outcome).toBe("queued");
    expect(result.proposalKind).toBe("knowledge");
    expect(result.lessonRef).toBe("knowledge:deploy");
    expect(receivedPrompt).toContain("produce a concise\n*knowledge* markdown document");
    expect(receivedPrompt).toContain("Produce the knowledge markdown file now.");

    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ref).toBe(durableRef(stash, "knowledge", "deploy"));
    expect(proposals[0].payload.content).toContain("# Deploy Guidance");
  });

  test("explicit knowledge mode rejects bodyless output without lesson-specific errors", async () => {
    const stash = makeStashDir();
    let threw: Error | undefined;
    try {
      await akmDistill({
        ref: "skill:deploy",
        proposalKind: "knowledge",
        config: configEnabled(stash),
        stashDir: stash,
        chat: async () => "---\ndescription: empty\n---\n",
        lookupFn: noopLookup,
        readEventsFn: emptyEvents,
      });
    } catch (err) {
      threw = err as Error;
    }

    expect(threw).toBeInstanceOf(Error);
    expect(threw?.message).toContain("knowledge");
    expect(threw?.message).toContain("non-empty markdown body");
    expect(threw?.message).not.toContain("when_to_use");
    expect(listProposals(stash)).toEqual([]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.at(-1)?.metadata?.outcome).toBe("validation_failed");
    expect(events.at(-1)?.metadata?.proposalKind).toBe("knowledge");
  });

  test("explicit knowledge mode rejects placeholder `description: ---`", async () => {
    const stash = makeStashDir();
    let threw: Error | undefined;
    try {
      await akmDistill({
        ref: "memory:session-checkpoint",
        proposalKind: "knowledge",
        config: configEnabled(stash),
        stashDir: stash,
        chat: async () =>
          "---\ndescription: ---\nsources:\n  - memory:session-checkpoint\n---\n\n# Some body content\nReal text here.\n",
        lookupFn: noopLookup,
        readEventsFn: emptyEvents,
      });
    } catch (err) {
      threw = err as Error;
    }

    expect(threw).toBeInstanceOf(Error);
    expect(threw?.message).toContain("invalid description");
    expect(listProposals(stash)).toEqual([]);
  });

  test("explicit knowledge mode rejects double-frontmatter output", async () => {
    const stash = makeStashDir();
    let threw: Error | undefined;
    try {
      await akmDistill({
        ref: "memory:session-checkpoint",
        proposalKind: "knowledge",
        config: configEnabled(stash),
        stashDir: stash,
        chat: async () =>
          "---\ndescription: Real summary of the session checkpoint\nsources:\n  - memory:session-checkpoint\n---\n\n---\nakm_memory_kind: session_checkpoint\n---\n\n# Body\nText.\n",
        lookupFn: noopLookup,
        readEventsFn: emptyEvents,
      });
    } catch (err) {
      threw = err as Error;
    }

    expect(threw).toBeInstanceOf(Error);
    expect(threw?.message).toMatch(/double-frontmatter|fence lines/);
    expect(listProposals(stash)).toEqual([]);
  });

  test.each([
    {
      name: "negative feedback blocks promotion",
      frontmatter: [
        "description: VPN required before deploy",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
      ],
      body: "Always connect the VPN before starting production deploys.",
      signals: ["positive", "negative", "positive"] as Array<"positive" | "negative">,
    },
    {
      name: "single positive signal is not enough",
      frontmatter: [
        "description: VPN required before deploy",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
      ],
      body: "Always connect the VPN before starting production deploys.",
      signals: ["positive"] as Array<"positive" | "negative">,
    },
    {
      name: "subjective memories do not promote",
      frontmatter: [
        "description: VPN required before deploy",
        "subjective: true",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
      ],
      body: "I prefer connecting the VPN before starting production deploys.",
      signals: ["positive", "positive"] as Array<"positive" | "negative">,
    },
    {
      name: "expiring memories stay as lessons",
      frontmatter: [
        "description: Temporary deploy token workaround",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
        "expires: 2026-06-01",
      ],
      body: "Use the temporary deploy token workaround until the incident is closed.",
      signals: ["positive", "positive"] as Array<"positive" | "negative">,
    },
    {
      name: "proposed memories do not promote",
      frontmatter: [
        "description: VPN required before deploy",
        "quality: proposed",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
      ],
      body: "Always connect the VPN before starting production deploys.",
      signals: ["positive", "positive"] as Array<"positive" | "negative">,
    },
    {
      name: "insufficient stability signals do not promote",
      frontmatter: ["description: VPN required before deploy", "source: skill:deploy"],
      body: "Always connect the VPN before starting production deploys.",
      signals: ["positive", "positive"] as Array<"positive" | "negative">,
    },
    {
      name: "contradicted memories do not promote",
      frontmatter: [
        "description: VPN required before deploy",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
        "contradictedBy: [memory:deploy-fact.derived]",
      ],
      body: "Always connect the VPN before starting production deploys.",
      signals: ["positive", "positive"] as Array<"positive" | "negative">,
    },
    {
      name: "tentative memories do not promote",
      frontmatter: [
        "description: Deploy may require VPN",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
      ],
      body: "Maybe connect the VPN before starting production deploys.",
      signals: ["positive", "positive"] as Array<"positive" | "negative">,
    },
  ])("promotion boundary: $name", async ({ frontmatter, body, signals }) => {
    const stash = makeStashDir();
    const memoryFile = path.join(stash, "memories", "deploy-fact.md");
    fs.writeFileSync(memoryFile, ["---", ...frontmatter, "---", "", body, ""].join("\n"), "utf8");

    const result = await akmDistill({
      ref: "memory:deploy-fact",
      proposalKind: "auto",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: async () => memoryFile,
      readEventsFn: eventsFor("memory:deploy-fact", signals),
    });

    expect(result.outcome).toBe("queued");
    expect(result.proposalKind).toBe("lesson");
    expect(result.lessonRef).toBe("lesson:memory-deploy-fact-lesson");
    expect(result.proposalRef).toBe("lesson:memory-deploy-fact-lesson");

    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ref).toBe(durableRef(stash, "lesson", "memory-deploy-fact-lesson"));
    expect(proposals[0].payload.content).toContain("when_to_use:");
    expect(proposals[0].payload.content).not.toContain("sources:");

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events).toHaveLength(1);
    expect(events[0].metadata?.proposalKind).toBe("lesson");
    expect(events[0].metadata?.proposalRef).toBe("lesson:memory-deploy-fact-lesson");
  });

  test("scored promotion can still pass without curated quality when the fixture is strongly reinforced", () => {
    const assessment = assessMemoryKnowledgePromotionCandidate({
      inputRef: "memory:deploy-fact",
      assetContent: [
        "---",
        "description: VPN required before deploy",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
        "tags: [deploy, ops]",
        "---",
        "",
        "Always connect the VPN before starting production deploys.",
        "",
      ].join("\n"),
      feedbackEvents: [{ metadata: { signal: "positive" } }, { metadata: { signal: "positive" } }],
    });

    expect(assessment.promote).toBe(true);
    expect(assessment.score).toBeGreaterThanOrEqual(assessment.threshold);
    expect(assessment.positiveSignals).toContain("repeated reinforcement");
    expect(assessment.positiveSignals).toContain("strong confidence");
  });

  test("feedback contradiction markers block deterministic promotion", async () => {
    const stash = makeStashDir();
    const memoryFile = path.join(stash, "memories", "deploy-fact.md");
    fs.writeFileSync(
      memoryFile,
      [
        "---",
        "description: VPN required before deploy",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
        "---",
        "",
        "Always connect the VPN before starting production deploys.",
        "",
      ].join("\n"),
      "utf8",
    );

    const contradictoryEvents = (() => ({
      events: [
        {
          schemaVersion: 1 as const,
          id: 1,
          ts: "2026-04-27T00:00:01Z",
          eventType: "feedback",
          ref: "memory:deploy-fact",
          metadata: { signal: "positive" },
        },
        {
          schemaVersion: 1 as const,
          id: 2,
          ts: "2026-04-27T00:00:02Z",
          eventType: "feedback",
          ref: "memory:deploy-fact",
          metadata: { signal: "positive", conflict: true },
        },
      ],
      nextOffset: 0,
    })) as unknown as typeof readEvents;

    const result = await akmDistill({
      ref: "memory:deploy-fact",
      proposalKind: "auto",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: async () => memoryFile,
      readEventsFn: contradictoryEvents,
    });

    expect(result.outcome).toBe("queued");
    expect(result.proposalKind).toBe("lesson");
    expect(listProposals(stash)).toHaveLength(1);
    expect(listProposals(stash)[0].ref).toBe(durableRef(stash, "lesson", "memory-deploy-fact-lesson"));
  });
});

// ── #267: excludeFeedbackFromRefs option ─────────────────────────────────────

describe("akmDistill — excludeFeedbackFromRefs (#267)", () => {
  test("filters out events whose ref is in the exclusion list", async () => {
    const stash = makeStashDir();
    let receivedPrompt = "";
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async (_cfg, messages) => {
        // Capture only the FIRST (distill) prompt. (The quality gate is off in
        // configEnabled, so no judge second-call clobbers this — the guard is
        // kept defensively.)
        if (!receivedPrompt) receivedPrompt = messages.map((m) => m.content).join("\n");
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
        // Capture only the FIRST (distill) prompt. (The quality gate is off in
        // configEnabled, so no judge second-call clobbers this — the guard is
        // kept defensively.)
        if (!receivedPrompt) receivedPrompt = messages.map((m) => m.content).join("\n");
        return VALID_LESSON;
      },
      lookupFn: noopLookup,
      readEventsFn: eventsFor("skill:deploy", ["negative", "positive"]),
      excludeFeedbackFromRefs: ["memory:other"],
    });
    expect(result.outcome).toBe("queued");
    expect(result.filteredFeedbackCount).toBe(0);
    expect(result.feedbackFullyFiltered).toBe(false);
    // D-3: negative/positive signals now appear in verbal contrast sections.
    expect(receivedPrompt).toContain("## What failed");
    expect(receivedPrompt).toContain("## What worked");
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
  test("feature_distillation: true but no `llm` block → outcome=llm_failed, no crash", async () => {
    const stash = makeStashDir();
    // Construct a config WITH features enabled but WITHOUT the `llm` block.
    // Validation in parseLlmFeatures requires `llm`; we bypass that by
    // assembling the shape directly (this mimics a partial / racy config).
    // The gate is OPEN (distill: true) but the inner LLM call
    // throws ConfigError("LLM_NOT_CONFIGURED") → tryLlmFeature catches it
    // with reason "error" → outcome resolves to `llm_failed`.
    // Gate is open (distill enabled) but no llm profile is wired.
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
      improve: { strategies: { default: { processes: { distill: { enabled: true } } } } },
    };
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
    expect(result.outcome).toBe("llm_failed");
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

  test("config_disabled result preserves the same outer shape but omits proposalId", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      // Explicitly disable distill — 0.8.0 default is enabled, so an absent
      // flag no longer trips the gate; we have to set processes.distill.enabled: false.
      config: configDisabled(stash),
      stashDir: stash,
      chat: async () => {
        throw new Error("must not be called");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("config_disabled");
    expect(result.proposalId).toBeUndefined();
    expect((result as unknown as { schemaVersion: number }).schemaVersion).toBe(1);
  });
});

// ── D-1 / #369 — fast path forces LLM when destination knowledge exists ───────

describe("D-1: fast path calls LLM merge when destination knowledge exists (#369)", () => {
  test("NOOP: LLM says no update needed — proposal is skipped", async () => {
    const stash = makeStashDir();
    // Create an existing knowledge file at the destination
    const existingKnowledgePath = path.join(stash, "knowledge", "auth-guide.md");
    fs.mkdirSync(path.dirname(existingKnowledgePath), { recursive: true });
    fs.writeFileSync(existingKnowledgePath, "---\ndescription: Auth guide\n---\nExisting auth content.\n", "utf8");

    const memPath1 = path.join(stash, "memories", "auth-guide.md");
    fs.mkdirSync(path.dirname(memPath1), { recursive: true });
    fs.writeFileSync(
      memPath1,
      [
        "---",
        "description: VPN required",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.95",
        "---",
        "",
        "Always connect the VPN.",
        "",
      ].join("\n"),
      "utf8",
    );

    // LLM returns NOOP — keep existing content
    const chatCalls: string[] = [];
    const result = await akmDistill({
      ref: "memory:auth-guide",
      proposalKind: "auto",
      stashDir: stash,
      config: distillConfig(stash, { qualityGate: { enabled: false } }),
      lookupFn: async (ref: string) => {
        if (ref === "memory:auth-guide") return memPath1;
        if (ref.includes("auth-guide")) return existingKnowledgePath;
        return null;
      },
      readEventsFn: eventsFor("memory:auth-guide", ["positive", "positive"]),
      chat: async (_cfg, msgs) => {
        chatCalls.push(msgs[1]?.content ?? "");
        return JSON.stringify({ action: "NOOP", content: "" });
      },
    });

    // D-1: NOOP → proposal not created, outcome skipped
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("skipped");
    expect(chatCalls.length).toBeGreaterThan(0); // LLM was called for merge resolution
  });

  test("UPDATE: LLM produces merged content — proposal queued with merged content", async () => {
    const stash = makeStashDir();
    const existingKnowledgePath = path.join(stash, "knowledge", "auth-guide2.md");
    fs.mkdirSync(path.dirname(existingKnowledgePath), { recursive: true });
    fs.writeFileSync(existingKnowledgePath, "---\ndescription: Auth guide v1\n---\nOld auth content.\n", "utf8");

    const memPath2 = path.join(stash, "memories", "auth-guide2.md");
    fs.mkdirSync(path.dirname(memPath2), { recursive: true });
    fs.writeFileSync(
      memPath2,
      [
        "---",
        "description: VPN required v2",
        "source: skill:deploy",
        "observed_at: 2026-04-21",
        "confidence: 0.95",
        "---",
        "",
        "Updated auth tips.",
        "",
      ].join("\n"),
      "utf8",
    );

    const mergedContent = "---\ndescription: Auth guide v2 (merged)\n---\nMerged auth content.\n";
    const result = await akmDistill({
      ref: "memory:auth-guide2",
      proposalKind: "auto",
      stashDir: stash,
      config: distillConfig(stash, { qualityGate: { enabled: false } }),
      lookupFn: async (ref: string) => {
        if (ref === "memory:auth-guide2") return memPath2;
        if (ref.includes("auth-guide2")) return existingKnowledgePath;
        return null;
      },
      readEventsFn: eventsFor("memory:auth-guide2", ["positive", "positive"]),
      chat: async () => JSON.stringify({ action: "UPDATE", content: mergedContent }),
    });

    // D-1: UPDATE → proposal queued with merged content
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("queued");
    const { listProposals } = await import("../../src/commands/proposal/repository");
    // WI-8.5a: proposals.ref is now the durable item_ref; result.lessonRef is the
    // legacy display spelling, so query the queue directly (one proposal here).
    const proposals = listProposals(stash);
    expect(proposals.length).toBeGreaterThan(0);
    const proposal = proposals[0];
    expect(proposal?.payload.content).toContain("Merged auth content");
  });
});

// ── Pipeline-fix regression tests (improve-pipeline-fixes branch) ────────────
//
// These tests pin the systematic failure modes observed across 323 archived
// rejected distill proposals on the 0.8.x release branch. Each test maps to
// one of the four root causes the pipeline fix targets:
//   1. Recursive lesson distillation (lesson:lesson-…-lesson-lesson refs).
//   2. Double-frontmatter blocks (YAML header + bold-markdown restatement).
//   3. `description` is a section-heading fragment or placeholder.
//   4. `when_to_use` is the circular "When working with <ref>" fallback.

describe("isValidDescription (pipeline-fix regression)", () => {
  test.each([
    ["For example", "section heading too short"],
    ["To reduce clutter", "section heading too short"],
    ["Key pitfalls", "section heading"],
    ["Key fixes focus on", "ends with preposition"],
    ["Always validate your setup with", "ends with preposition"],
    ["Lesson distilled from lesson:foo", "literal placeholder"],
    ["30", "pure number / too short"],
    ["", "empty"],
    ["When the deploy fails, retry once with the safe flag enabled.", "starts with When"],
    ["# Heading line", "starts with markdown marker"],
  ])("rejects %j (%s)", (bad, _why) => {
    const r = isValidDescription(bad, "skill:deploy");
    expect(r.ok).toBe(false);
  });

  test.each([
    "Prefer ripgrep over grep on large repos",
    "Always validate project filter existence before aborting to prevent premature workflow termination.",
    "Use HMR-safe imports so SvelteKit does not double-evaluate stateful module-level code.",
  ])("accepts %j", (good) => {
    const r = isValidDescription(good, "skill:deploy");
    expect(r.ok).toBe(true);
  });

  test("rejects description that just names the input ref's slug verbatim", () => {
    // The slug includes hyphens; this description contains the exact slug.
    const r = isValidDescription(
      "Notes about pagedjs-content-none-transform-workaround.",
      "knowledge:pagedjs-content-none-transform-workaround",
    );
    expect(r.ok).toBe(false);
  });

  // Code-fragment shape — added 2026-05-21 after triage found a proposal with
  // `description: "def _dedup_proposal(proposal)"` (LLM pasted a function
  // signature from the source memory body into the description field).
  test.each([
    "def _dedup_proposal(proposal) -> ProposalResult",
    "function handleClick(event: MouseEvent): void",
    "async def fetch_data(url: string) -> Response",
    "class ProposalValidator extends BaseValidator",
    "const STALE_THRESHOLD_MS = 86400000 // ms",
    "export function isValidDescription(value: unknown)",
    "import { isValidDescription } from '../../src/commands/improve/distill'",
    "func handleProposal(p Proposal) error { return nil }",
  ])("rejects code-fragment description %j", (codey) => {
    const r = isValidDescription(codey, "skill:deploy");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/code/i);
    }
  });

  test("rejects description with unbalanced backticks", () => {
    const r = isValidDescription(
      "Use the `--dry-run flag to preview proposals before writing them to disk.",
      "skill:deploy",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/backtick/i);
  });

  test("accepts description with balanced inline code", () => {
    // Sanity check: balanced backticks must still pass.
    const r = isValidDescription(
      "Use the `--dry-run` flag to preview proposals before writing them to disk.",
      "skill:deploy",
    );
    expect(r.ok).toBe(true);
  });
});

describe("isValidWhenToUse (pipeline-fix regression)", () => {
  test("rejects the circular fallback `When working with <slug>`", () => {
    const r = isValidWhenToUse(
      "When working with pagedjs-content-none-transform-workaround.",
      "knowledge:pagedjs-content-none-transform-workaround",
    );
    expect(r.ok).toBe(false);
  });

  test("rejects too-short triggers", () => {
    expect(isValidWhenToUse("When deploying.", "skill:deploy").ok).toBe(false);
  });

  test("accepts a real trigger sentence", () => {
    const r = isValidWhenToUse(
      "When designing a CSS solution for Paged.js footers that need content: none after the runtime stylesheet.",
      "knowledge:pagedjs",
    );
    expect(r.ok).toBe(true);
  });
});

describe("detectDoubleFrontmatter (pipeline-fix regression)", () => {
  test("flags content with three or more `---` fences", () => {
    const bad = [
      "---",
      "description: First-frontmatter description here is long enough to pass.",
      "when_to_use: First-frontmatter trigger sentence here is long enough to pass.",
      "---",
      "",
      "---",
      "Some body that has its own fence below.",
      "---",
    ].join("\n");
    const r = detectDoubleFrontmatter(bad);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("double-frontmatter-fence");
  });

  test("flags bold-markdown `**description:**` pseudo-frontmatter in body", () => {
    const bad = [
      "---",
      "description: Real description that is long enough to be acceptable.",
      "when_to_use: Real trigger that is long enough to be acceptable.",
      "---",
      "",
      "**description:** something else entirely",
      "**when_to_use:** another contradiction",
      "",
      "Lesson body prose.",
    ].join("\n");
    const r = detectDoubleFrontmatter(bad);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("pseudo-frontmatter-in-body");
  });

  test("passes a clean lesson with a single frontmatter block", () => {
    const ok = [
      "---",
      "description: Real description that is long enough to be acceptable.",
      "when_to_use: Real trigger that is long enough to be acceptable.",
      "---",
      "",
      "Lesson body without restated metadata.",
    ].join("\n");
    expect(detectDoubleFrontmatter(ok)).toBeNull();
  });
});

describe("akmDistill — pipeline-fix integration", () => {
  test("refuses lesson refs as input (recursive-distillation guard)", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "lesson:skill-deploy-lesson",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => {
        throw new Error("chat must not be called when input ref is a lesson");
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("skipped");
    expect(result.lessonRef).toBe("lesson:skill-deploy-lesson");
    expect(listProposals(stash)).toEqual([]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.at(-1)?.metadata?.skipReason).toBe("recursive_lesson_input");
    // CRITICAL: the proposed ref must NOT carry the recursive `lesson-…-lesson-lesson` shape.
    expect(result.lessonRef).not.toMatch(/^lesson:lesson-/);
    expect(result.lessonRef).not.toMatch(/-lesson-lesson$/);
  });

  test("refuses env/secret refs as input (08-F2: secret bytes never reach the LLM)", async () => {
    const stash = makeStashDir();
    for (const ref of ["env:prod-api", "secret:signing-key"]) {
      const result = await akmDistill({
        ref,
        config: configEnabled(stash),
        stashDir: stash,
        chat: async () => {
          throw new Error("chat must not be called for a secret input");
        },
        // The structural refusal fires BEFORE lookup/readFileSync — proving the
        // secret file is never opened.
        lookupFn: async () => {
          throw new Error("lookup/readFileSync must not run for a secret input");
        },
        readEventsFn: emptyEvents,
      });
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("skipped");
      const { events } = readEvents({ type: "distill_invoked" });
      expect(events.at(-1)?.metadata?.skipReason).toBe("refused_secret_input");
    }
    expect(listProposals(stash)).toEqual([]);
  });

  test("LLM returns the archived recursive-lesson bad fixture → validation_failed (no broken proposal queued)", async () => {
    // Synthesised from proposal id 187de1c9-d7eb-47c1-92a2-23ad29f669cc (lesson-of-a-lesson
    // with double frontmatter, placeholder description, and circular when_to_use). The
    // recursive-ref guard fires first, so chat is never called — but to be defensive we
    // also exercise the path where the bad content comes from a non-lesson source.
    const stash = makeStashDir();
    const archivedBadContent = [
      "---",
      'description: "Lesson distilled from knowledge:foo"',
      'when_to_use: "When working with foo."',
      "---",
      "",
      "---",
      "**description:** Real-looking text crammed into the body.",
      "**when_to_use:** Another contradiction crammed into the body.",
      "",
      "Some prose that an LLM happened to write.",
    ].join("\n");

    let threw: Error | undefined;
    try {
      await akmDistill({
        ref: "knowledge:foo",
        config: configEnabled(stash),
        stashDir: stash,
        chat: async () => archivedBadContent,
        lookupFn: noopLookup,
        readEventsFn: emptyEvents,
      });
    } catch (err) {
      threw = err as Error;
    }

    expect(threw).toBeInstanceOf(Error);
    expect(threw?.message).toMatch(/description|when_to_use|frontmatter/);
    expect(listProposals(stash)).toEqual([]);

    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.at(-1)?.metadata?.outcome).toBe("validation_failed");
    const findingKinds = events.at(-1)?.metadata?.findingKinds as string[] | undefined;
    expect(findingKinds?.some((k) => /description|when_to_use|frontmatter/.test(k))).toBe(true);
  });

  test("LLM returns description='Key pitfalls' → validation_failed (section-heading fragment caught)", async () => {
    const stash = makeStashDir();
    const badContent = [
      "---",
      'description: "Key pitfalls"',
      'when_to_use: "When working with pagedjs."',
      "---",
      "",
      "Body explaining the pitfalls of Paged.js usage.",
    ].join("\n");

    let threw: Error | undefined;
    try {
      await akmDistill({
        ref: "knowledge:pagedjs",
        config: configEnabled(stash),
        stashDir: stash,
        chat: async () => badContent,
        lookupFn: noopLookup,
        readEventsFn: emptyEvents,
      });
    } catch (err) {
      threw = err as Error;
    }

    expect(threw).toBeInstanceOf(Error);
    expect(listProposals(stash)).toEqual([]);
    const { events } = readEvents({ type: "distill_invoked" });
    expect(events.at(-1)?.metadata?.outcome).toBe("validation_failed");
  });

  test("memory: source with valid LLM output → proposal queued (happy-path stays green)", async () => {
    const stash = makeStashDir();
    const goodLesson = [
      "---",
      "description: Always connect to the corporate VPN before triggering a production deploy.",
      "when_to_use: When deploying to production over an untrusted network from a remote workstation.",
      "---",
      "",
      "Production deploys assume an authenticated origin. Run the VPN check first.",
    ].join("\n");
    const result = await akmDistill({
      ref: "memory:deploy-tips",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => goodLesson,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("queued");
    expect(result.lessonRef).toBe("lesson:memory-deploy-tips-lesson");
    expect(listProposals(stash).length).toBe(1);
  });
});

// ── R3/G4: judge-verdict routing + output encoding salience ──────────────────

describe("akmDistill — R3 judge verdict routing + G4 output encoding salience", () => {
  test("queued lesson stamps judgeConfidence on the event and content-scores the OUTPUT ref", async () => {
    const stash = makeStashDir();
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configJudgeEnabled(stash),
      stashDir: stash,
      chat: async (_cfg, messages) => {
        const joined = messages.map((m) => m.content).join("\n");
        // The second call is the quality judge — return a parseable passing
        // verdict so confidence is defined.
        if (joined.includes("Score this lesson")) return JSON.stringify({ score: 4.5, reason: "adds new info" });
        return VALID_LESSON;
      },
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("queued");

    // R3: the judge verdict is longitudinally queryable on the queued event
    // (normalized score/5), not just a one-shot proposal.confidence write.
    const { events } = readEvents({ type: "distill_invoked" });
    const queued = events.find((e) => e.metadata?.outcome === "queued");
    expect(queued?.metadata?.judgeConfidence).toBeCloseTo(4.5 / 5, 9);

    // G4: the OUTPUT lesson ref carries a real content-derived encoding score
    // from creation (lessons are refused as distill inputs, so this is their
    // only chance to escape the type-weight stub).
    const db = openStateDatabase();
    try {
      const row = getAssetSalience(db, result.lessonRef as string);
      expect(row).toBeDefined();
      expect(row?.encoding_source).toBe("content");
      expect(row?.encoding_salience).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("07 P0-2 end-to-end: gate ON + unjudgeable verdict → proposal REJECTED, not queued", async () => {
    const stash = makeStashDir();
    // Distill returns a valid lesson, but the judge's second call receives the
    // same non-JSON text → parse failure → the gate fails CLOSED. This drives
    // the whole akmDistill path (not just runLessonQualityJudge in isolation)
    // to prove unjudgeable minted content is rejected, never queued.
    const result = await akmDistill({
      ref: "skill:deploy",
      config: configJudgeEnabled(stash),
      stashDir: stash,
      chat: async () => VALID_LESSON,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("quality_rejected");
    expect(result.score).toBe(-1);
    expect(listProposals(stash).length).toBe(0);
  });
});
