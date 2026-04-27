/**
 * Tests for the graph-extraction pass (#207).
 *
 * `extractGraphFromBody` is mocked via `mock.module` so no real LLM call
 * is ever made. These tests cover:
 *   - eligible-file detection (memory + knowledge .md, inferred children skipped)
 *   - the disabled-by-default path (no `akm.llm` configured)
 *   - the `index.graph.llm = false` per-pass opt-out
 *   - the `llm.features.graph_extraction = false` feature-gate opt-out
 *   - graph.json is written under `<stashRoot>/.akm/`
 *   - toggling off after a successful run leaves the existing graph.json on disk
 *   - read-only cache sources are not extracted (only the primary stash)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig } from "../src/core/config";
import type { SearchSource } from "../src/indexer/search-source";

// ── Module-level LLM stub ───────────────────────────────────────────────────

let extractor: (body: string) => { entities: string[]; relations: { from: string; to: string; type?: string }[] } =
  () => ({
    entities: [],
    relations: [],
  });

mock.module("../src/llm/graph-extract", () => ({
  extractGraphFromBody: async (_config: unknown, body: string) => extractor(body),
}));

// Import AFTER mock.module so the pass picks up the stub.
const { runGraphExtractionPass, collectEligibleFiles, getGraphFilePath, GRAPH_FILE_SCHEMA_VERSION } = await import(
  "../src/indexer/graph-extraction"
);

// ── Fixture helpers ─────────────────────────────────────────────────────────

let tmpStash = "";

beforeEach(() => {
  tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-ext-"));
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  fs.mkdirSync(path.join(tmpStash, "knowledge"), { recursive: true });
  extractor = () => ({ entities: [], relations: [] });
});

afterEach(() => {
  if (tmpStash) {
    fs.rmSync(tmpStash, { recursive: true, force: true });
    tmpStash = "";
  }
});

function writeFile(rel: string, frontmatter: Record<string, unknown>, body: string): string {
  const fmLines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    fmLines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  fmLines.push("---");
  const content = `${fmLines.join("\n")}\n\n${body}\n`;
  const filePath = path.join(tmpStash, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

const SAMPLE_LLM = {
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "llama3.2",
};

function configWithLlm(overrides?: Partial<AkmConfig>): AkmConfig {
  return {
    semanticSearchMode: "auto",
    llm: { ...SAMPLE_LLM },
    ...overrides,
  };
}

function sources(): SearchSource[] {
  return [{ path: tmpStash }];
}

// ── collectEligibleFiles ────────────────────────────────────────────────────

describe("collectEligibleFiles", () => {
  test("returns empty when neither memories/ nor knowledge/ exists", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-empty-"));
    try {
      expect(collectEligibleFiles(fresh)).toEqual([]);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("walks memories/ and knowledge/ markdown files", () => {
    writeFile("memories/m1.md", {}, "Memory body about ServiceA and ServiceB.");
    writeFile("knowledge/k1.md", {}, "Knowledge body about ServiceB.");
    writeFile("memories/sub/m2.md", {}, "Nested memory body.");

    const eligible = collectEligibleFiles(tmpStash);
    const names = eligible.map((e) => path.relative(tmpStash, e.absPath)).sort();
    expect(names).toEqual([
      path.join("knowledge", "k1.md"),
      path.join("memories", "m1.md"),
      path.join("memories", "sub", "m2.md"),
    ]);
  });

  test("skips inferred memory children", () => {
    writeFile("memories/parent.md", {}, "Parent body.");
    writeFile("memories/parent.facts/fact-1.md", { inferred: true, source: "memory:parent" }, "Atomic.");

    const eligible = collectEligibleFiles(tmpStash);
    const names = eligible.map((e) => path.relative(tmpStash, e.absPath));
    expect(names).toContain(path.join("memories", "parent.md"));
    expect(names).not.toContain(path.join("memories", "parent.facts", "fact-1.md"));
  });

  test("skips empty bodies", () => {
    // File with parseable frontmatter and a whitespace-only body. The
    // empty `{}` frontmatter form is degenerate (no delimiters with
    // contents between them), so we use a single key to force a real
    // frontmatter block.
    writeFile("memories/empty.md", { type: "memory" }, "   \n\n   ");
    expect(collectEligibleFiles(tmpStash)).toEqual([]);
  });
});

// ── runGraphExtractionPass — disabled paths ────────────────────────────────

describe("runGraphExtractionPass — disabled paths", () => {
  test("no-op when no akm.llm is configured", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when no llm is configured");
    };
    const result = await runGraphExtractionPass({ semanticSearchMode: "auto" }, sources());
    expect(result.written).toBe(false);
    expect(result.considered).toBe(0);
    expect(fs.existsSync(getGraphFilePath(tmpStash))).toBe(false);
  });

  test("no-op when index.graph.llm = false", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when per-pass disabled");
    };
    const cfg = configWithLlm({ index: { graph: { llm: false } } });
    const result = await runGraphExtractionPass(cfg, sources());
    expect(result.written).toBe(false);
    expect(fs.existsSync(getGraphFilePath(tmpStash))).toBe(false);
  });

  test("no-op when llm.features.graph_extraction = false", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when feature-gated off");
    };
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      llm: { ...SAMPLE_LLM, features: { graph_extraction: false } },
      index: { graph: { llm: true } },
    };
    const result = await runGraphExtractionPass(cfg, sources());
    expect(result.written).toBe(false);
    expect(fs.existsSync(getGraphFilePath(tmpStash))).toBe(false);
  });

  test("toggling off after a successful run preserves the existing graph.json", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });
    await runGraphExtractionPass(configWithLlm(), sources());

    const graphPath = getGraphFilePath(tmpStash);
    expect(fs.existsSync(graphPath)).toBe(true);
    const beforeBytes = fs.readFileSync(graphPath, "utf8");

    extractor = () => {
      throw new Error("must not be called when disabled");
    };
    await runGraphExtractionPass(configWithLlm({ index: { graph: { llm: false } } }), sources());

    expect(fs.existsSync(graphPath)).toBe(true);
    expect(fs.readFileSync(graphPath, "utf8")).toBe(beforeBytes);
  });
});

// ── runGraphExtractionPass — orthogonal gating (§14 + #208) ────────────────

describe("runGraphExtractionPass — feature flag and per-pass key are orthogonal", () => {
  test("runs when both gates allow", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["E"], relations: [] });
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      llm: { ...SAMPLE_LLM, features: { graph_extraction: true } },
    };
    const result = await runGraphExtractionPass(cfg, sources());
    expect(result.written).toBe(true);
    expect(result.considered).toBe(1);
    expect(result.extracted).toBe(1);
  });

  test("either gate set to false short-circuits", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["E"], relations: [] });
    const featureOff = await runGraphExtractionPass(
      {
        semanticSearchMode: "auto",
        llm: { ...SAMPLE_LLM, features: { graph_extraction: false } },
      },
      sources(),
    );
    expect(featureOff.written).toBe(false);

    const passOff = await runGraphExtractionPass(
      {
        semanticSearchMode: "auto",
        llm: { ...SAMPLE_LLM, features: { graph_extraction: true } },
        index: { graph: { llm: false } },
      },
      sources(),
    );
    expect(passOff.written).toBe(false);
  });
});

// ── runGraphExtractionPass — enabled path ──────────────────────────────────

describe("runGraphExtractionPass — enabled", () => {
  test("writes graph.json with schema version + canonicalised entities", async () => {
    writeFile("memories/parent.md", {}, "Body about ServiceA and ServiceB.");
    writeFile("knowledge/k1.md", {}, "Body about ServiceB and ServiceC.");
    extractor = (body) => {
      if (body.includes("ServiceA"))
        return {
          entities: ["ServiceA", "ServiceB"],
          relations: [{ from: "ServiceA", to: "ServiceB", type: "uses" }],
        };
      return {
        entities: ["ServiceB", "ServiceC"],
        relations: [{ from: "ServiceB", to: "ServiceC" }],
      };
    };

    const result = await runGraphExtractionPass(configWithLlm(), sources());

    expect(result.written).toBe(true);
    expect(result.considered).toBe(2);
    expect(result.extracted).toBe(2);
    expect(result.totalEntities).toBe(4);
    expect(result.totalRelations).toBe(2);

    const raw = fs.readFileSync(getGraphFilePath(tmpStash), "utf8");
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      stashRoot: string;
      files: Array<{
        path: string;
        type: string;
        entities: string[];
        relations: Array<{ from: string; to: string; type?: string }>;
      }>;
    };
    expect(parsed.schemaVersion).toBe(GRAPH_FILE_SCHEMA_VERSION);
    expect(parsed.stashRoot).toBe(tmpStash);
    expect(parsed.files).toHaveLength(2);
    // Entities are lower-cased at write time so the search-time boost
    // doesn't have to re-canonicalise on every query.
    for (const node of parsed.files) {
      for (const e of node.entities) expect(e).toBe(e.toLowerCase());
      for (const r of node.relations) {
        expect(r.from).toBe(r.from.toLowerCase());
        expect(r.to).toBe(r.to.toLowerCase());
      }
    }
  });

  test("files with no extracted entities are omitted but still considered", async () => {
    writeFile("memories/m1.md", {}, "Empty graph body.");
    writeFile("memories/m2.md", {}, "Has entities.");
    extractor = (body) => {
      if (body.includes("Has entities")) return { entities: ["X"], relations: [] };
      return { entities: [], relations: [] };
    };

    const result = await runGraphExtractionPass(configWithLlm(), sources());
    expect(result.considered).toBe(2);
    expect(result.extracted).toBe(1);
    expect(result.written).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(getGraphFilePath(tmpStash), "utf8")) as { files: unknown[] };
    expect(parsed.files).toHaveLength(1);
  });

  test("does not extract from cache-only sources (only the primary stash)", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-cache-"));
    try {
      fs.mkdirSync(path.join(cacheDir, "memories"), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "memories", "cache.md"), "---\n---\n\nCache body about X.\n");

      writeFile("memories/m1.md", {}, "Primary body.");
      extractor = () => ({ entities: ["X"], relations: [] });

      const result = await runGraphExtractionPass(configWithLlm(), [{ path: tmpStash }, { path: cacheDir }]);
      expect(result.considered).toBe(1);
      expect(fs.existsSync(getGraphFilePath(cacheDir))).toBe(false);
      expect(fs.existsSync(getGraphFilePath(tmpStash))).toBe(true);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
