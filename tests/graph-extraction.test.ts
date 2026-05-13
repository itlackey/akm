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
import type { GraphQualityTelemetry } from "../src/indexer/graph-extraction";
import type { SearchSource } from "../src/indexer/search-source";

// ── Module-level LLM stub ───────────────────────────────────────────────────

let extractor: (body: string) => {
  entities: string[];
  relations: { from: string; to: string; type?: string; confidence?: number }[];
  confidence?: number;
} = () => ({
  entities: [],
  relations: [],
});
let extractorCallCount = 0;

mock.module("../src/llm/graph-extract", () => ({
  extractGraphFromBody: async (_config: unknown, body: string) => {
    extractorCallCount++;
    return extractor(body);
  },
  // Stub the batch API introduced with batching support — each body is processed
  // independently via the single-body extractor to keep test logic simple.
  extractGraphFromBodies: async (_config: unknown, bodies: string[]) =>
    Promise.all(bodies.map((body) => extractor(body))),
}));

// Import AFTER mock.module so the pass picks up the stub.
const {
  runGraphExtractionPass,
  collectEligibleFiles,
  getGraphFilePath,
  GRAPH_FILE_SCHEMA_VERSION,
  getGraphExtractionIncludeTypes,
} = await import("../src/indexer/graph-extraction");

// ── Fixture helpers ─────────────────────────────────────────────────────────

let tmpStash = "";

beforeEach(() => {
  tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-ext-"));
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  fs.mkdirSync(path.join(tmpStash, "knowledge"), { recursive: true });
  extractor = () => ({ entities: [], relations: [] });
  extractorCallCount = 0;
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

  test("supports configurable include types while default remains memory+knowledge", () => {
    writeFile("memories/m1.md", {}, "Memory body.");
    writeFile("knowledge/k1.md", {}, "Knowledge body.");
    writeFile("commands/c1.md", {}, "Command body.");

    const defaults = collectEligibleFiles(tmpStash);
    const defaultNames = defaults.map((e) => path.relative(tmpStash, e.absPath)).sort();
    expect(defaultNames).toEqual([path.join("knowledge", "k1.md"), path.join("memories", "m1.md")]);

    const expanded = collectEligibleFiles(tmpStash, ["memory", "command"]);
    const expandedNames = expanded.map((e) => path.relative(tmpStash, e.absPath)).sort();
    expect(expandedNames).toEqual([path.join("commands", "c1.md"), path.join("memories", "m1.md")]);
  });

  test("resolves include types from config with safe fallback", () => {
    expect(getGraphExtractionIncludeTypes({ semanticSearchMode: "auto" })).toEqual(["memory", "knowledge"]);
    expect(
      getGraphExtractionIncludeTypes({
        semanticSearchMode: "auto",
        index: { graph: { graphExtractionIncludeTypes: ["memory", "command", "memory"] } },
      }),
    ).toEqual(["memory", "command"]);
  });

  test("skips inferred memory children", () => {
    writeFile("memories/parent.md", {}, "Parent body.");
    writeFile("memories/parent.derived.md", { inferred: true, source: "memory:parent" }, "# Derived\n\nCompressed.");

    const eligible = collectEligibleFiles(tmpStash);
    const names = eligible.map((e) => path.relative(tmpStash, e.absPath));
    expect(names).toContain(path.join("memories", "parent.md"));
    expect(names).not.toContain(path.join("memories", "parent.derived.md"));
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

  test("no-op cleanly when feature + per-pass gates allow but akm.llm is absent (third precondition)", async () => {
    // Three preconditions must ALL hold for the pass to run:
    //   1. `akm.llm` configured  (this test removes it)
    //   2. `llm.features.graph_extraction !== false`  (true here)
    //   3. `index.graph.llm !== false`  (true here)
    // With #1 missing, the pass must short-circuit silently — no error
    // thrown, no graph.json written, no existing graph.json modified.
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when akm.llm is absent");
    };
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      // No `llm` block at all.
      index: { graph: { llm: true } },
    };
    const graphPath = getGraphFilePath(tmpStash);
    expect(fs.existsSync(graphPath)).toBe(false);
    const result = await runGraphExtractionPass(cfg, sources());
    expect(result.written).toBe(false);
    expect(result.considered).toBe(0);
    expect(result.extracted).toBe(0);
    expect(fs.existsSync(graphPath)).toBe(false);
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

describe("runGraphExtractionPass — progress", () => {
  test("emits per-file progress events", async () => {
    writeFile("memories/m1.md", {}, "Body one.");
    writeFile("knowledge/k1.md", {}, "Body two.");
    extractor = () => ({ entities: ["E"], relations: [] });

    const events: Array<{ processed: number; total: number; currentPath?: string }> = [];
    const result = await runGraphExtractionPass(configWithLlm(), sources(), undefined, undefined, false, (event) => {
      events.push({ processed: event.processed, total: event.total, currentPath: event.currentPath });
    });

    expect(result.extracted).toBe(2);
    expect(events[0]).toEqual({ processed: 0, total: 2, currentPath: undefined });
    expect(events.some((event) => event.processed === 1 && event.total === 2)).toBe(true);
    expect(events.some((event) => event.processed === 2 && event.total === 2)).toBe(true);
    expect(events.some((event) => event.currentPath?.endsWith("m1.md") || event.currentPath?.endsWith("k1.md"))).toBe(
      true,
    );
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
          relations: [{ from: "ServiceA", to: "ServiceB", type: "uses", confidence: 0.72 }],
          confidence: 0.91,
        };
      return {
        entities: ["ServiceB", "ServiceC"],
        relations: [{ from: "ServiceB", to: "ServiceC" }],
        confidence: 0.66,
      };
    };

    const result = await runGraphExtractionPass(configWithLlm(), sources());

    expect(result.written).toBe(true);
    expect(result.considered).toBe(2);
    expect(result.extracted).toBe(2);
    expect(result.totalEntities).toBe(4);
    expect(result.totalRelations).toBe(2);
    expect(result.quality).toEqual({
      consideredFiles: 2,
      extractedFiles: 2,
      entityCount: 3,
      relationCount: 2,
      extractionCoverage: 1,
      density: 0.6667,
    });

    const raw = fs.readFileSync(getGraphFilePath(tmpStash), "utf8");
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      stashRoot: string;
      quality?: GraphQualityTelemetry;
      files: Array<{
        path: string;
        type: string;
        entities: string[];
        relations: Array<{ from: string; to: string; type?: string; confidence?: number }>;
        confidence?: number;
      }>;
    };
    expect(parsed.schemaVersion).toBe(GRAPH_FILE_SCHEMA_VERSION);
    expect(parsed.stashRoot).toBe(tmpStash);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.quality).toEqual({
      consideredFiles: 2,
      extractedFiles: 2,
      entityCount: 3,
      relationCount: 2,
      extractionCoverage: 1,
      density: 0.6667,
    });
    // Entities are lower-cased at write time so the search-time boost
    // doesn't have to re-canonicalise on every query.
    for (const node of parsed.files) {
      for (const e of node.entities) expect(e).toBe(e.toLowerCase());
      for (const r of node.relations) {
        expect(r.from).toBe(r.from.toLowerCase());
        expect(r.to).toBe(r.to.toLowerCase());
      }
    }
    expect(parsed.files.some((node) => typeof node.confidence === "number")).toBe(true);
    expect(parsed.files.some((node) => node.relations.some((rel) => typeof rel.confidence === "number"))).toBe(true);
  });

  test("include-types config can expand extraction beyond memory/knowledge", async () => {
    writeFile("memories/m1.md", {}, "Memory body about A.");
    writeFile("commands/c1.md", {}, "Command body about B.");
    extractor = () => ({ entities: ["X"], relations: [] });

    const result = await runGraphExtractionPass(
      configWithLlm({ index: { graph: { graphExtractionIncludeTypes: ["memory", "command"] } } }),
      sources(),
    );

    expect(result.considered).toBe(2);
    expect(result.extracted).toBe(2);
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

  test("leaves an existing graph.json untouched when every extraction returns no entities", async () => {
    writeFile("memories/m1.md", {}, "Empty graph body.");
    const graphPath = getGraphFilePath(tmpStash);
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, "sentinel", "utf8");
    extractor = () => ({ entities: [], relations: [] });

    const result = await runGraphExtractionPass(configWithLlm(), sources());

    expect(result.considered).toBe(1);
    expect(result.extracted).toBe(0);
    expect(result.written).toBe(false);
    expect(fs.readFileSync(graphPath, "utf8")).toBe("sentinel");
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

  test("incremental no-op reuses prior graph nodes when body hash matches", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });

    const first = await runGraphExtractionPass(configWithLlm(), sources());
    expect(first.written).toBe(true);
    expect(extractorCallCount).toBe(1);

    extractor = () => {
      throw new Error("must not be called when prior graph node is reusable");
    };

    const second = await runGraphExtractionPass(configWithLlm(), sources());
    expect(second.written).toBe(true);
    expect(second.extracted).toBe(1);
    expect(extractorCallCount).toBe(1);
  });

  test("changed file body hash invalidates prior graph node and falls back to extraction", async () => {
    const filePath = writeFile("memories/m1.md", {}, "Original body about ServiceA.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });
    await runGraphExtractionPass(configWithLlm(), sources());
    expect(extractorCallCount).toBe(1);

    fs.writeFileSync(filePath, "---\n---\n\nUpdated body about ServiceB.\n", "utf8");
    extractor = () => ({ entities: ["ServiceB"], relations: [] });

    const second = await runGraphExtractionPass(configWithLlm(), sources());
    expect(second.written).toBe(true);
    expect(extractorCallCount).toBe(2);

    const graph = JSON.parse(fs.readFileSync(getGraphFilePath(tmpStash), "utf8")) as {
      files: Array<{ entities: string[] }>;
    };
    expect(graph.files[0]?.entities).toContain("serviceb");
  });

  test("invalid prior graph node falls back safely to fresh extraction", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });
    await runGraphExtractionPass(configWithLlm(), sources());
    expect(extractorCallCount).toBe(1);

    const graphPath = getGraphFilePath(tmpStash);
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf8")) as {
      schemaVersion: number;
      generatedAt: string;
      stashRoot: string;
      files: Array<Record<string, unknown>>;
      entities?: string[];
      relations?: unknown[];
    };
    graph.files[0] = {
      ...graph.files[0],
      entities: "not-an-array",
    };
    fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    extractor = () => ({ entities: ["ServiceC"], relations: [] });
    const second = await runGraphExtractionPass(configWithLlm(), sources());
    expect(second.written).toBe(true);
    expect(extractorCallCount).toBe(2);

    const repaired = JSON.parse(fs.readFileSync(graphPath, "utf8")) as {
      files: Array<{ entities: string[] }>;
    };
    expect(repaired.files[0]?.entities).toContain("servicec");
  });
});
