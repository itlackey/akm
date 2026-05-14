/**
 * Tests for the graph-extraction pass (#207).
 *
 * `extractGraphFromBody` is mocked via `mock.module` so no real LLM call
 * is ever made. These tests cover:
 *   - eligible-file detection (memory + knowledge .md, inferred children skipped)
 *   - the disabled-by-default path (no `akm.llm` configured)
 *   - the `index.graph.llm = false` per-pass opt-out
 *   - the `llm.features.graph_extraction = false` feature-gate opt-out
 *   - graph data is written into the SQLite graph tables for the stash
 *   - toggling off after a successful run leaves the existing graph snapshot intact
 *   - read-only cache sources are not extracted (only the primary stash)
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig } from "../src/core/config";
import { closeDatabase, openDatabase } from "../src/indexer/db";
import { loadStoredGraphSnapshot, replaceStoredGraph } from "../src/indexer/graph-db";
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
const { runGraphExtractionPass, collectEligibleFiles, GRAPH_FILE_SCHEMA_VERSION, getGraphExtractionIncludeTypes } =
  await import("../src/indexer/graph-extraction");

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

afterAll(() => {
  mock.restore();
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

function withGraphDb<T>(name: string, fn: (db: import("bun:sqlite").Database) => Promise<T> | T): Promise<T> | T {
  void name;
  const db = openDatabase(path.join(tmpStash, "graph-test.db"));
  const result = fn(db);
  if (result instanceof Promise) {
    return result.finally(() => {
      closeDatabase(db);
    }) as Promise<T>;
  }
  try {
    closeDatabase(db);
    return result;
  } finally {
    // no-op
  }
}

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
    const result = await withGraphDb("disabled-no-llm", (db) =>
      runGraphExtractionPass({ semanticSearchMode: "auto" }, sources(), undefined, db),
    );
    expect(result.written).toBe(false);
    expect(result.considered).toBe(0);
  });

  test("no-op when index.graph.llm = false", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when per-pass disabled");
    };
    const cfg = configWithLlm({ index: { graph: { llm: false } } });
    const result = await withGraphDb("disabled-pass-gate", (db) =>
      runGraphExtractionPass(cfg, sources(), undefined, db),
    );
    expect(result.written).toBe(false);
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
    const result = await withGraphDb("feature-gated-off", (db) =>
      runGraphExtractionPass(cfg, sources(), undefined, db),
    );
    expect(result.written).toBe(false);
  });

  test("toggling off after a successful run preserves the existing SQLite graph snapshot", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });
    await withGraphDb("toggle-preserve", async (db) => {
      await runGraphExtractionPass(configWithLlm(), sources(), undefined, db);
      const before = loadStoredGraphSnapshot(tmpStash, db);
      expect(before).not.toBeNull();

      extractor = () => {
        throw new Error("must not be called when disabled");
      };
      await runGraphExtractionPass(configWithLlm({ index: { graph: { llm: false } } }), sources(), undefined, db);

      const after = loadStoredGraphSnapshot(tmpStash, db);
      expect(after).toEqual(before);
    });
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
    const result = await withGraphDb("both-gates-allow", (db) => runGraphExtractionPass(cfg, sources(), undefined, db));
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
    // thrown, no graph snapshot written, no existing graph snapshot modified.
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when akm.llm is absent");
    };
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      // No `llm` block at all.
      index: { graph: { llm: true } },
    };
    const result = await withGraphDb("llm-absent-third-precondition", (db) =>
      runGraphExtractionPass(cfg, sources(), undefined, db),
    );
    expect(result.written).toBe(false);
    expect(result.considered).toBe(0);
    expect(result.extracted).toBe(0);
  });

  test("either gate set to false short-circuits", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["E"], relations: [] });
    const featureOff = await withGraphDb("either-gate-feature-off", (db) =>
      runGraphExtractionPass(
        {
          semanticSearchMode: "auto",
          llm: { ...SAMPLE_LLM, features: { graph_extraction: false } },
        },
        sources(),
        undefined,
        db,
      ),
    );
    expect(featureOff.written).toBe(false);

    const passOff = await withGraphDb("either-gate-pass-off", (db) =>
      runGraphExtractionPass(
        {
          semanticSearchMode: "auto",
          llm: { ...SAMPLE_LLM, features: { graph_extraction: true } },
          index: { graph: { llm: false } },
        },
        sources(),
        undefined,
        db,
      ),
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
    const result = await withGraphDb("progress", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db, false, (event) => {
        events.push({ processed: event.processed, total: event.total, currentPath: event.currentPath });
      }),
    );

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
  test("writes SQLite graph rows with schema version + canonical entity names", async () => {
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

    const result = await withGraphDb("writes-graph", async (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    const parsed = await withGraphDb("writes-graph-read", (db) => loadStoredGraphSnapshot(tmpStash, db));

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

    if (!parsed) throw new Error("expected stored graph snapshot");
    expect(parsed.schemaVersion).toBe(GRAPH_FILE_SCHEMA_VERSION);
    expect(parsed.stashPath).toBe(tmpStash);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.quality).toEqual({
      consideredFiles: 2,
      extractedFiles: 2,
      entityCount: 3,
      relationCount: 2,
      extractionCoverage: 1,
      density: 0.6667,
    });
    const parentNode = parsed.files.find((file) => file.path.endsWith(path.join("memories", "parent.md")));
    const knowledgeNode = parsed.files.find((file) => file.path.endsWith(path.join("knowledge", "k1.md")));
    expect(parentNode?.entities).toEqual(["ServiceA", "ServiceB"]);
    expect(knowledgeNode?.entities).toEqual(["ServiceB", "ServiceC"]);
    expect(parentNode?.relations[0]).toMatchObject({ from: "ServiceA", to: "ServiceB", type: "uses" });
    expect(parsed.files.some((node) => typeof node.confidence === "number")).toBe(true);
    expect(parsed.files.some((node) => node.relations.some((rel) => typeof rel.confidence === "number"))).toBe(true);
  });

  test("include-types config can expand extraction beyond memory/knowledge", async () => {
    writeFile("memories/m1.md", {}, "Memory body about A.");
    writeFile("commands/c1.md", {}, "Command body about B.");
    extractor = () => ({ entities: ["X"], relations: [] });

    const result = await withGraphDb("include-types-expand", (db) =>
      runGraphExtractionPass(
        configWithLlm({ index: { graph: { graphExtractionIncludeTypes: ["memory", "command"] } } }),
        sources(),
        undefined,
        db,
      ),
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

    const result = await withGraphDb("omit-empty-entities", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    expect(result.considered).toBe(2);
    expect(result.extracted).toBe(1);
    expect(result.written).toBe(true);

    const parsed = await withGraphDb("omit-empty-entities-read", (db) => loadStoredGraphSnapshot(tmpStash, db));
    if (!parsed) throw new Error("expected stored graph snapshot");
    expect(parsed.files).toHaveLength(1);
  });

  test("candidate-path refresh preserves unrelated nodes from the existing graph", async () => {
    const memoryPath = writeFile("memories/m1.md", {}, "Body about ServiceA.");
    writeFile("knowledge/k1.md", {}, "Body about ServiceB.");
    extractor = (body) => {
      if (body.includes("ServiceA")) return { entities: ["ServiceA"], relations: [] };
      return { entities: ["ServiceB"], relations: [] };
    };

    await withGraphDb("candidate-preserve-initial", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    fs.writeFileSync(memoryPath, "---\n---\n\nBody about ServiceA updated.\n", "utf8");

    extractor = (body) => {
      if (body.includes("updated")) return { entities: ["ServiceA2"], relations: [] };
      throw new Error("untouched file should be preserved from the previous graph");
    };

    const result = await withGraphDb("candidate-preserve-refresh", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db, false, undefined, {
        candidatePaths: new Set([memoryPath]),
      }),
    );

    expect(result.written).toBe(true);
    const parsed = (await withGraphDb("candidate-preserve-read", (db) => loadStoredGraphSnapshot(tmpStash, db))) as {
      files: Array<{ path: string; entities: string[] }>;
      entities: string[];
    };
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files.find((node) => node.path === memoryPath)?.entities).toEqual(["ServiceA2"]);
    expect(parsed.entities.sort()).toEqual(["ServiceA2", "ServiceB"]);
  });

  test("candidate-path refresh removes touched nodes that no longer yield graph entities", async () => {
    const memoryPath = writeFile("memories/m1.md", {}, "Body about ServiceA.");
    writeFile("knowledge/k1.md", {}, "Body about ServiceB.");
    extractor = (body) => {
      if (body.includes("ServiceA")) return { entities: ["ServiceA"], relations: [] };
      return { entities: ["ServiceB"], relations: [] };
    };

    await withGraphDb("candidate-remove-initial", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    fs.writeFileSync(memoryPath, "---\n---\n\nBody about ServiceA updated again.\n", "utf8");

    extractor = (body) => {
      if (body.includes("updated again")) return { entities: [], relations: [] };
      throw new Error("untouched file should be preserved from the previous graph");
    };

    const result = await withGraphDb("candidate-remove-refresh", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db, false, undefined, {
        candidatePaths: new Set([memoryPath]),
      }),
    );

    expect(result.written).toBe(true);
    const parsed = (await withGraphDb("candidate-remove-read", (db) => loadStoredGraphSnapshot(tmpStash, db))) as {
      files: Array<{ path: string; entities: string[] }>;
      entities: string[];
    };
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe(path.join(tmpStash, "knowledge", "k1.md"));
    expect(parsed.entities).toEqual(["ServiceB"]);
  });

  test("leaves an existing stored graph untouched when every extraction returns no entities", async () => {
    writeFile("memories/m1.md", {}, "Empty graph body.");
    extractor = () => ({ entities: [], relations: [] });

    await withGraphDb("existing-graph-sentinel", (db) =>
      replaceStoredGraph(db, {
        schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: tmpStash,
        files: [
          {
            path: path.join(tmpStash, "memories", "sentinel.md"),
            type: "memory",
            entities: ["Sentinel"],
            relations: [],
          },
        ],
      }),
    );

    const result = await withGraphDb("existing-graph-noop", async (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    const after = await withGraphDb("existing-graph-noop-read", (db) => loadStoredGraphSnapshot(tmpStash, db));

    expect(result.considered).toBe(1);
    expect(result.extracted).toBe(0);
    expect(result.written).toBe(false);
    if (!after) throw new Error("expected existing stored graph snapshot");
    expect(after.files[0]?.entities).toEqual(["Sentinel"]);
  });

  test("does not extract from cache-only sources (only the primary stash)", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-cache-"));
    try {
      fs.mkdirSync(path.join(cacheDir, "memories"), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "memories", "cache.md"), "---\n---\n\nCache body about X.\n");

      writeFile("memories/m1.md", {}, "Primary body.");
      extractor = () => ({ entities: ["X"], relations: [] });

      const result = await withGraphDb("cache-only-source", (db) =>
        runGraphExtractionPass(configWithLlm(), [{ path: tmpStash }, { path: cacheDir }], undefined, db),
      );
      expect(result.considered).toBe(1);
      await withGraphDb("cache-only-source-read", (db) => {
        expect(loadStoredGraphSnapshot(cacheDir, db)).toBeNull();
        expect(loadStoredGraphSnapshot(tmpStash, db)).not.toBeNull();
      });
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("incremental no-op reuses prior graph nodes when body hash matches", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });

    const first = await withGraphDb("incremental-reuse-first", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    expect(first.written).toBe(true);
    expect(extractorCallCount).toBe(1);

    extractor = () => {
      throw new Error("must not be called when prior graph node is reusable");
    };

    const second = await withGraphDb("incremental-reuse-second", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    expect(second.written).toBe(true);
    expect(second.extracted).toBe(1);
    expect(extractorCallCount).toBe(1);
  });

  test("changed file body hash invalidates prior graph node and falls back to extraction", async () => {
    const filePath = writeFile("memories/m1.md", {}, "Original body about ServiceA.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });
    await withGraphDb("hash-invalidate-first", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    expect(extractorCallCount).toBe(1);

    fs.writeFileSync(filePath, "---\n---\n\nUpdated body about ServiceB.\n", "utf8");
    extractor = () => ({ entities: ["ServiceB"], relations: [] });

    const second = await withGraphDb("hash-invalidate-second", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    expect(second.written).toBe(true);
    expect(extractorCallCount).toBe(2);

    const graph = (await withGraphDb("hash-invalidate-read", (db) => loadStoredGraphSnapshot(tmpStash, db))) as {
      files: Array<{ entities: string[] }>;
    };
    expect(graph.files[0]?.entities).toContain("ServiceB");
  });

  test("invalid prior graph node falls back safely to fresh extraction", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });
    await withGraphDb("invalid-prior-first", (db) => runGraphExtractionPass(configWithLlm(), sources(), undefined, db));
    expect(extractorCallCount).toBe(1);

    await withGraphDb("invalid-prior-corrupt", (db) => {
      const filePath = path.join(tmpStash, "memories", "m1.md");
      db.prepare("UPDATE graph_files SET body_hash = NULL WHERE stash_root = ? AND file_path = ?").run(
        tmpStash,
        filePath,
      );
      db.prepare("DELETE FROM llm_enrichment_cache WHERE asset_ref = ?").run(filePath);
    });

    extractor = () => ({ entities: ["ServiceC"], relations: [] });
    const second = await withGraphDb("invalid-prior-second", (db) =>
      runGraphExtractionPass(configWithLlm(), sources(), undefined, db),
    );
    expect(second.written).toBe(true);
    expect(extractorCallCount).toBe(2);

    const repaired = (await withGraphDb("invalid-prior-read", (db) => loadStoredGraphSnapshot(tmpStash, db))) as {
      files: Array<{ entities: string[] }>;
    };
    expect(repaired.files[0]?.entities).toContain("ServiceC");
  });
});
