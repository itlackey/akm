/**
 * Tests for the structured-output (`responseSchema`) lift in `akm distill`.
 *
 * Asset-writers-investigation PR 1: providers that honour
 * `response_format: json_schema` return a typed JSON object
 * (`{description, when_to_use, body, tags?, sources?}`) which distill
 * re-assembles into the canonical `---\n<fm>\n---\n\n<body>` markdown. The
 * existing prompt-contract markdown path remains as a fallback for providers
 * that ignore the schema and for the `chat` test seam that returns strings.
 *
 * Coverage:
 *   1. Schema shape: required fields, additionalProperties off, kind-specific
 *      field sets.
 *   2. Assembly helper: structured payload → canonical markdown; missing
 *      required field → null (caller falls through to markdown path).
 *   3. End-to-end: a JSON-stringified payload returned via the `chat` seam is
 *      assembled and queued just like the markdown path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  akmDistill,
  assembleStructuredDistillMarkdown,
  DISTILL_KNOWLEDGE_JSON_SCHEMA,
  DISTILL_LESSON_JSON_SCHEMA,
} from "../../../src/commands/improve/distill";
import { listProposals } from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import type { readEvents } from "../../../src/core/events";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

// ── Scaffolding ─────────────────────────────────────────────────────────────

let storage: IsolatedAkmStorage;

function makeStashDir(): string {
  return storage.stashDir;
}

function configEnabled(stashDir: string): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    engines: {
      default: {
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
      },
    },
    improve: {
      strategies: {
        // Quality gate OFF: these tests exercise the structured-output chat seam
        // round-trip, not the LLM-as-judge. The gate defaults ON and fails CLOSED
        // (07 P0-2) with a non-judge chat stub.
        test: { processes: { distill: { enabled: true, qualityGate: { enabled: false } } } },
      },
    },
    defaults: { llmEngine: "default", improveStrategy: "test" },
  };
}

const noopLookup = async () => null;
const emptyEvents = (() => ({ events: [], nextOffset: 0 })) as unknown as typeof readEvents;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

// ── 1. Schema shape ─────────────────────────────────────────────────────────

describe("DISTILL_LESSON_JSON_SCHEMA", () => {
  test("requires description, when_to_use, body — the three load-bearing lesson fields", () => {
    const schema = DISTILL_LESSON_JSON_SCHEMA as { required: string[]; type: string };
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("description");
    expect(schema.required).toContain("when_to_use");
    expect(schema.required).toContain("body");
  });

  test("forbids additionalProperties so providers cannot smuggle ad-hoc fields past the schema", () => {
    const schema = DISTILL_LESSON_JSON_SCHEMA as { additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
  });

  test("tags is optional and typed as a string array", () => {
    const schema = DISTILL_LESSON_JSON_SCHEMA as {
      properties: Record<string, { type?: string; items?: { type?: string } }>;
      required: string[];
    };
    expect(schema.required).not.toContain("tags");
    expect(schema.properties.tags?.type).toBe("array");
    expect(schema.properties.tags?.items?.type).toBe("string");
  });
});

describe("DISTILL_KNOWLEDGE_JSON_SCHEMA", () => {
  test("requires description and body but NOT when_to_use (knowledge has no trigger field)", () => {
    const schema = DISTILL_KNOWLEDGE_JSON_SCHEMA as { required: string[] };
    expect(schema.required).toContain("description");
    expect(schema.required).toContain("body");
    expect(schema.required).not.toContain("when_to_use");
  });

  test("exposes optional sources array for provenance tracking", () => {
    const schema = DISTILL_KNOWLEDGE_JSON_SCHEMA as {
      properties: Record<string, { type?: string; items?: { type?: string } }>;
      required: string[];
    };
    expect(schema.required).not.toContain("sources");
    expect(schema.properties.sources?.type).toBe("array");
    expect(schema.properties.sources?.items?.type).toBe("string");
  });
});

// ── 2. Assembly helper ──────────────────────────────────────────────────────

describe("assembleStructuredDistillMarkdown — lesson kind", () => {
  test("assembles canonical markdown when all required fields are present", () => {
    const out = assembleStructuredDistillMarkdown(
      {
        description: "Use rg over grep for multi-thousand-file repos.",
        when_to_use: "When searching a monorepo for symbols across many files.",
        body: "Prefer `rg` to `grep -r`. It is faster and respects `.gitignore` by default.",
      },
      "lesson",
    );
    expect(out).not.toBeNull();
    expect(out).toContain("---\n");
    expect(out).toContain("description:");
    expect(out).toContain("when_to_use:");
    expect(out?.endsWith("\n")).toBe(true);
    // Body appears after the closing `---`.
    expect(out).toContain("\n---\n\n");
  });

  test("returns null when when_to_use is missing — caller falls through to markdown path", () => {
    const out = assembleStructuredDistillMarkdown(
      // Cast through unknown to silence the strict-shape compile error and
      // verify the runtime guard does its job.
      { description: "Has description", body: "Has body" } as unknown as Record<string, unknown>,
      "lesson",
    );
    expect(out).toBeNull();
  });

  test("returns null when body is empty whitespace — content guard fires", () => {
    const out = assembleStructuredDistillMarkdown(
      {
        description: "Has description",
        when_to_use: "When trigger present",
        body: "   ",
      },
      "lesson",
    );
    expect(out).toBeNull();
  });

  test("includes optional tags array when non-empty", () => {
    const out = assembleStructuredDistillMarkdown(
      {
        description: "Has description",
        when_to_use: "When trigger present",
        body: "Body text.",
        tags: ["search", "tooling"],
      },
      "lesson",
    );
    expect(out).toContain("tags:");
    expect(out).toContain('"search"');
    expect(out).toContain('"tooling"');
  });

  test("drops empty tags array — frontmatter stays minimal", () => {
    const out = assembleStructuredDistillMarkdown(
      {
        description: "Has description",
        when_to_use: "When trigger present",
        body: "Body text.",
        tags: [],
      },
      "lesson",
    );
    expect(out).not.toContain("tags:");
  });
});

describe("assembleStructuredDistillMarkdown — knowledge kind", () => {
  test("knowledge assembly does NOT require when_to_use", () => {
    const out = assembleStructuredDistillMarkdown(
      {
        description: "Durable deploy guidance.",
        body: "# Deploy Guidance\n\nConnect the VPN before production deploys.",
      },
      "knowledge",
    );
    expect(out).not.toBeNull();
    expect(out).not.toContain("when_to_use");
    expect(out).toContain("description:");
  });

  test("knowledge serialises source refs as canonical xrefs when present", () => {
    const out = assembleStructuredDistillMarkdown(
      {
        description: "Durable guidance.",
        body: "# Body",
        sources: ["skills/deploy", "knowledge/vpn-policy"],
      },
      "knowledge",
    );
    expect(out).toContain("xrefs:");
    expect(out).toContain('"skills/deploy"');
    expect(out).toContain('"knowledge/vpn-policy"');
  });
});

// ── 3. End-to-end via the chat seam ─────────────────────────────────────────

describe("akmDistill — structured-output chat seam round-trip", () => {
  test("chat returning a JSON-stringified lesson payload is assembled and queued like markdown", async () => {
    const stash = makeStashDir();
    // Simulate what a schema-honouring provider emits — a JSON string of the
    // structured payload, not a markdown blob. parseEmbeddedJsonResponse picks
    // it up and assembleStructuredDistillMarkdown rebuilds the markdown.
    const payload = JSON.stringify({
      description: "Always validate the ripgrep installation before running searches across large monorepos.",
      when_to_use: "When searching a multi-thousand-file repo for symbols.",
      body: "Use `rg` instead of `grep -r`. It is faster and respects `.gitignore` by default.",
    });
    const result = await akmDistill({
      ref: "skills/deploy",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => payload,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });

    expect(result.outcome).toBe("queued");
    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.payload.frontmatter?.description).toContain("ripgrep");
    expect(proposals[0]!.payload.frontmatter?.when_to_use).toContain("multi-thousand-file");
    expect(proposals[0]!.payload.content).toContain("Use `rg`");
  });

  test("structured payload missing when_to_use falls through to markdown path (validation_failed)", async () => {
    // Belt-and-suspenders: even if a provider ignored the schema's `required`
    // contract and returned an incomplete object, we drop into the legacy
    // markdown pipeline. With no embedded `---` frontmatter the auto-repair
    // refuses to fabricate a circular when_to_use, and the lesson lint
    // rejects the proposal cleanly.
    const stash = makeStashDir();
    const payload = JSON.stringify({
      description: "I forgot to emit when_to_use.",
      body: "Some body text without a trigger sentence.",
    });
    let threw: Error | undefined;
    try {
      await akmDistill({
        ref: "skills/deploy",
        config: configEnabled(stash),
        stashDir: stash,
        chat: async () => payload,
        lookupFn: noopLookup,
        readEventsFn: emptyEvents,
      });
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).toBeInstanceOf(Error);
    expect(listProposals(stash)).toEqual([]);
  });

  test("structured payload assembled into markdown round-trips through the proposal pipeline", async () => {
    // Pin the observable result: with a valid structured payload, the queued
    // proposal's typed frontmatter mirrors exactly what the LLM returned.
    const stash = makeStashDir();
    const payload = JSON.stringify({
      description: "Run the indexer with --rebuild after major schema migrations to drop stale embeddings.",
      when_to_use: "When the embedding model or asset spec changes between releases.",
      body: "## Steps\n\n1. Stop background indexer jobs.\n2. Run `akm index --rebuild`.\n3. Verify counts match.",
    });
    const result = await akmDistill({
      ref: "skills/reindex",
      config: configEnabled(stash),
      stashDir: stash,
      chat: async () => payload,
      lookupFn: noopLookup,
      readEventsFn: emptyEvents,
    });
    expect(result.outcome).toBe("queued");
    const proposals = listProposals(stash);
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.payload.frontmatter?.description).toContain("indexer");
    expect(proposals[0]!.payload.content).toContain("## Steps");
    expect(proposals[0]!.payload.content).toContain("akm index --rebuild");
  });
});
