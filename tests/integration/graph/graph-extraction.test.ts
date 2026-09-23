/**
 * Tests for the graph-extraction pass (#207).
 *
 * Graph extraction runs against a local Bun HTTP server so the real
 * transport and parsing path is exercised without process-global module
 * mocking. These tests cover:
 *   - eligible-file detection (memory + knowledge .md, inferred children skipped)
 *   - the disabled-by-default path (no index engine configured)
 *   - the `index.graph.enabled = false` per-pass opt-out
 *   - graph data is written into the SQLite graph tables for the stash
 *   - toggling off after a successful run leaves the existing graph snapshot intact
 *   - read-only cache sources are not extracted (only the primary stash)
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import { enqueueGraphExtraction, loadStoredGraphSnapshot, replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { SearchSource } from "../../../src/indexer/search/search-source";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { computeBodyHash } from "../../../src/storage/repositories/index-llm-cache-repository";
import { type IsolatedAkmStorage, mutateScopedEnv, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";

// ── Local LLM server ────────────────────────────────────────────────────────

let extractor: (body: string) => {
  entities: string[];
  relations: { from: string; to: string; type?: string; confidence?: number }[];
  confidence?: number;
} = () => ({
  entities: [],
  relations: [],
});
let extractorCallCount = 0;
let onLlmRequest: ((request: Request) => void) | undefined;
/** Queue of HTTP status codes to return instead of a 200, for provider-error/failure tests (R2). */
const errorStatusQueue: number[] = [];

/**
 * Detect a batched graph-extract prompt and split it back into per-asset bodies.
 *
 * `extractGraphFromBodies` builds a prompt of the form:
 *   "Extract entities and relations from the N=K assets below.
 *    ...rules...
 *    === ASSET 1 ===
 *    <body 1>
 *    === ASSET 2 ===
 *    <body 2>
 *    ..."
 *
 * Returns an empty array if the prompt is a single-asset call. Otherwise
 * returns the per-asset bodies in order so the mock can invoke `extractor`
 * for each and assemble an array response matching the production contract.
 */
function parseBatchBodies(userContent: string): string[] {
  if (!userContent.includes("=== ASSET ") || !/\bN=\d+/.test(userContent)) return [];
  return userContent
    .split(/=== ASSET \d+ ===\n/g)
    .slice(1)
    .map((body) => body.trim())
    .filter(Boolean);
}

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    onLlmRequest?.(request);
    if (errorStatusQueue.length > 0) {
      const status = errorStatusQueue.shift() as number;
      return new Response("simulated provider error", { status });
    }
    const payload = (await request.json()) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const userContent = payload.messages?.find((m) => m.role === "user")?.content ?? "";
    extractorCallCount++;

    // Batch prompt: production sent N>=2 asset bodies in a single call and
    // expects a JSON array of N results. Without this branch the mock would
    // return a single object, force the non-array fallback path, and (after
    // 2 non-array responses) latch `batchingDisabled=true` — which is fine
    // in isolation but interacts badly with full-suite ordering once
    // pollution between tests is closed. Returning the array directly keeps
    // the mock contract aligned with what `extractGraphFromBodies` expects.
    const batchBodies = parseBatchBodies(userContent);
    if (batchBodies.length > 0) {
      const arr = batchBodies.map((body) => extractor(body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(arr) } }],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const content = JSON.stringify(extractor(userContent));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});

const { runGraphExtractionPass, collectEligibleFiles, GRAPH_FILE_SCHEMA_VERSION, getGraphExtractionIncludeTypes } =
  await import("../../../src/indexer/graph/graph-extraction");
const { GRAPH_EXTRACT_PROMPT_VERSION: graphExtractPromptVersion } = await import("../../../src/llm/graph-extract");

// ── Fixture helpers ─────────────────────────────────────────────────────────

let tmpStash = "";
let storage: IsolatedAkmStorage;

beforeEach(() => {
  // withIsolatedAkmStorage pairs the stash with XDG_DATA_HOME / XDG_STATE_HOME
  // so that any production helper inside graph-db / graph-extraction that
  // incidentally calls getDbPath()/getTaskHistoryStateDir() (e.g. populating
  // StoredGraphMeta.graphPath at src/indexer/graph-db.ts:410) does not fire
  // the test-isolation guard when a prior leaky test left
  // process.env.AKM_BUNDLE_DIR set. The stash scaffold already includes
  // memories/ and knowledge/.
  storage = withIsolatedAkmStorage();
  tmpStash = storage.stashDir;
  extractor = () => ({ entities: [], relations: [] });
  extractorCallCount = 0;
  onLlmRequest = undefined;
  errorStatusQueue.length = 0;
});

afterEach(() => {
  storage.cleanup();
  tmpStash = "";
});

afterAll(() => {
  llmServer.stop(true);
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

  // Schema v2: graph_files.entry_id FKs to entries.id. Seed a minimal entry
  // so replaceStoredGraph can resolve this file_path to an entry_id when
  // the graph extraction pass runs.
  const typeDir = rel.split("/")[0] ?? "";
  const type = typeDir === "memories" ? "memory" : typeDir === "knowledge" ? "knowledge" : typeDir;
  const name = path.basename(rel, path.extname(rel));
  const entry = {
    name,
    type,
    filename: path.basename(rel),
    ...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
  };
  const db = openIndexDatabase(path.join(tmpStash, "graph-test.db"));
  try {
    upsertEntry(
      db,
      filePath,
      entry,
      buildSearchText(entry as Parameters<typeof buildSearchText>[0]),
      deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, type, name),
    );
  } finally {
    closeDatabase(db);
  }
  return filePath;
}

const SAMPLE_LLM = {
  endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
  model: "llama3.2",
};

function withGraphDb<T>(
  name: string,
  fn: (db: import("../../../src/storage/database").Database) => Promise<T> | T,
): Promise<T> | T {
  void name;
  const db = openIndexDatabase(path.join(tmpStash, "graph-test.db"));
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
  const base: AkmConfig = {
    semanticSearchMode: "auto",
    engines: { index: { kind: "llm", ...SAMPLE_LLM } },
    index: { defaults: { engine: "index" } },
  };
  return {
    ...base,
    ...overrides,
    engines: { ...base.engines, ...overrides?.engines },
    index: {
      ...base.index,
      ...overrides?.index,
      defaults: { ...base.index?.defaults, ...overrides?.index?.defaults },
    },
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
    writeFile("memories/parent.derived.md", { inferred: true, source: "memories/parent" }, "# Derived\n\nCompressed.");

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
  test("no-op when no index engine is configured", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when no llm is configured");
    };
    const result = await withGraphDb("disabled-no-llm", (db) =>
      runGraphExtractionPass({ config: { semanticSearchMode: "auto" }, sources: sources(), db }),
    );
    expect(result.written).toBe(false);
    expect(result.considered).toBe(0);
  });

  test("no-op when index.graph.enabled = false", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when per-pass disabled");
    };
    const cfg = configWithLlm({ index: { graph: { enabled: false } } });
    const result = await withGraphDb("disabled-pass-gate", (db) =>
      runGraphExtractionPass({ config: cfg, sources: sources(), db }),
    );
    expect(result.written).toBe(false);
  });

  test("no-op when an improve-only graph engine is not configured for standalone indexing", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when feature-gated off");
    };
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { improveOnly: { kind: "llm", ...SAMPLE_LLM } },
      improve: {
        strategies: { default: { processes: { graphExtraction: { enabled: true, engine: "improveOnly" } } } },
      },
      index: { graph: { enabled: true } },
    };
    const result = await withGraphDb("feature-gated-off", (db) =>
      runGraphExtractionPass({ config: cfg, sources: sources(), db }),
    );
    expect(result.written).toBe(false);
  });

  test("toggling off after a successful run preserves the existing SQLite graph snapshot", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });
    await withGraphDb("toggle-preserve", async (db) => {
      await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db });
      const before = loadStoredGraphSnapshot(tmpStash, db);
      expect(before).not.toBeNull();

      extractor = () => {
        throw new Error("must not be called when disabled");
      };
      await runGraphExtractionPass({
        config: configWithLlm({ index: { graph: { enabled: false } } }),
        sources: sources(),
        db,
      });

      const after = loadStoredGraphSnapshot(tmpStash, db);
      expect(after).toEqual(before);
    });
  });
});

// ── runGraphExtractionPass — standalone index engine gating ────────────────

describe("runGraphExtractionPass — standalone index engine gating", () => {
  test.each([
    { name: "empty primary stash", withCacheSource: false },
    { name: "cache-only secondary source", withCacheSource: true },
  ])("does not materialize a required credential for an $name", async ({ withCacheSource }) => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-no-work-cache-"));
    try {
      if (withCacheSource) {
        fs.mkdirSync(path.join(cacheDir, "memories"), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, "memories", "cached.md"), "---\n---\n\nCache-only body.\n");
      }
      const cfg = configWithLlm({
        engines: {
          index: {
            kind: "llm",
            ...SAMPLE_LLM,
            apiKey: "$AKM_GRAPH_NO_WORK_REQUIRED_KEY",
          },
        },
        index: { defaults: { engine: "index" }, graph: { enabled: true } },
      });

      const result = await withEnv({ AKM_GRAPH_NO_WORK_REQUIRED_KEY: undefined }, () =>
        withGraphDb("required-key-no-work", (db) =>
          runGraphExtractionPass({
            config: cfg,
            sources: withCacheSource ? [{ path: tmpStash }, { path: cacheDir }] : sources(),
            db,
          }),
        ),
      );

      expect(result).toMatchObject({ written: false, considered: 0, extracted: 0 });
      expect(extractorCallCount).toBe(0);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("returns initial lowering notices from standalone symbolic selection", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["E"], relations: [] });
    const cfg = configWithLlm({
      index: {
        defaults: { engine: "index" },
        graph: { enabled: true, llm: { effort: "high" } },
      },
    });

    const result = await withGraphDb("standalone-selection-notices", (db) =>
      runGraphExtractionPass({ config: cfg, sources: sources(), db }),
    );

    expect(result.notices).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        adapter: "llm",
        field: "inference.effort",
      }),
    ]);
  });

  test("missing required credential writes neither graph cache nor graph row", async () => {
    writeFile("memories/m1.md", {}, "Body one.");
    writeFile("knowledge/k1.md", {}, "Body two.");
    const cfg = configWithLlm({
      engines: {
        index: {
          kind: "llm",
          ...SAMPLE_LLM,
          apiKey: "$AKM_GRAPH_REQUIRED_KEY",
        },
      },
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 2 } },
    });

    await withGraphDb("missing-required-credential", async (db) => {
      const failure = withEnv({ AKM_GRAPH_REQUIRED_KEY: undefined }, () =>
        runGraphExtractionPass({ config: cfg, sources: sources(), db }),
      );
      await expect(failure).rejects.toBeInstanceOf(ConfigError);
      await expect(failure).rejects.toMatchObject({ code: "INVALID_CONFIG_FILE" });
      expect(extractorCallCount).toBe(0);
      const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
      const graphCount = (
        db.prepare("SELECT COUNT(*) AS cnt FROM graph_files WHERE stash_root = ?").get(tmpStash) as { cnt: number }
      ).cnt;
      expect(cacheCount).toBe(0);
      expect(graphCount).toBe(0);
    });
  });

  test("single-file graph dispatches keep the preflight credential after removal", async () => {
    writeFile("memories/a.md", {}, "Alice works with Bob.");
    writeFile("memories/b.md", {}, "Carol supports Service C.");
    extractor = (body) => ({ entities: [body.includes("Alice") ? "Alice" : "Carol"], relations: [] });
    const cfg = configWithLlm({
      engines: { index: { kind: "llm", ...SAMPLE_LLM, apiKey: "$AKM_GRAPH_LEASE_SINGLE_KEY" } },
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 1 } },
    });
    const secret = "graph-single-original-092";
    const authorization: Array<string | null> = [];
    onLlmRequest = (request) => {
      authorization.push(request.headers.get("authorization"));
      if (authorization.length === 1) mutateScopedEnv("AKM_GRAPH_LEASE_SINGLE_KEY", undefined);
    };

    const result = await withEnv({ AKM_GRAPH_LEASE_SINGLE_KEY: secret }, () =>
      withGraphDb("single-lease", (db) => runGraphExtractionPass({ config: cfg, sources: sources(), db })),
    );
    expect(result).toMatchObject({ considered: 2, extracted: 2, written: true });
    expect(authorization).toEqual([`Bearer ${secret}`, `Bearer ${secret}`]);
  });

  test("batched graph dispatches keep the original credential after replacement", async () => {
    for (const name of ["a", "b", "c", "d"]) writeFile(`memories/${name}.md`, {}, `Body about ${name}.`);
    extractor = (body) => ({ entities: [body.slice(-2)], relations: [] });
    const cfg = configWithLlm({
      engines: { index: { kind: "llm", ...SAMPLE_LLM, apiKey: "$AKM_GRAPH_LEASE_BATCH_KEY" } },
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 2 } },
    });
    const secret = "graph-batch-original-092";
    const replacement = "graph-batch-replacement-092";
    const authorization: Array<string | null> = [];
    onLlmRequest = (request) => {
      authorization.push(request.headers.get("authorization"));
      if (authorization.length === 1) mutateScopedEnv("AKM_GRAPH_LEASE_BATCH_KEY", replacement);
    };

    const result = await withEnv({ AKM_GRAPH_LEASE_BATCH_KEY: secret }, () =>
      withGraphDb("batch-lease", (db) => runGraphExtractionPass({ config: cfg, sources: sources(), db })),
    );
    expect(result).toMatchObject({ considered: 4, extracted: 4, written: true });
    expect(authorization).toEqual([`Bearer ${secret}`, `Bearer ${secret}`]);
  });

  test("queued and sweep graph calls share one credential snapshot", async () => {
    const queuedPath = writeFile("memories/a-queued.md", {}, "Queued Alice body.");
    writeFile("memories/b-sweep.md", {}, "Sweep Bob body.");
    extractor = (body) => ({ entities: [body.includes("Alice") ? "Alice" : "Bob"], relations: [] });
    const cfg = configWithLlm({
      engines: { index: { kind: "llm", ...SAMPLE_LLM, apiKey: "$AKM_GRAPH_LEASE_QUEUE_KEY" } },
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 1 } },
    });
    const secret = "graph-queue-original-092";
    const authorization: Array<string | null> = [];
    onLlmRequest = (request) => {
      authorization.push(request.headers.get("authorization"));
      if (authorization.length === 1) mutateScopedEnv("AKM_GRAPH_LEASE_QUEUE_KEY", undefined);
    };

    const result = await withEnv({ AKM_GRAPH_LEASE_QUEUE_KEY: secret }, () =>
      withGraphDb("queue-lease", (db) => {
        enqueueGraphExtraction(db, tmpStash, queuedPath, computeBodyHash("Queued Alice body."), 10);
        return runGraphExtractionPass({ config: cfg, sources: sources(), db });
      }),
    );
    expect(result.written).toBe(true);
    expect(authorization).toEqual([`Bearer ${secret}`, `Bearer ${secret}`]);
  });

  test("an all-cache-hit sweep does not materialize a required credential", async () => {
    writeFile("memories/cache-hit.md", {}, "Alice works with Bob.");
    extractor = () => ({ entities: ["Alice", "Bob"], relations: [{ from: "Alice", to: "Bob" }] });
    const cfg = configWithLlm({
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 1 } },
    });

    await withGraphDb("prime-cache-hit", (db) => runGraphExtractionPass({ config: cfg, sources: sources(), db }));
    expect(extractorCallCount).toBe(1);
    const engine = cfg.engines?.index;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the index LLM engine");
    engine.apiKey = "$AKM_GRAPH_CACHE_HIT_REQUIRED_KEY";

    const result = await withEnv({ AKM_GRAPH_CACHE_HIT_REQUIRED_KEY: undefined }, () =>
      withGraphDb("required-key-cache-hit", (db) => runGraphExtractionPass({ config: cfg, sources: sources(), db })),
    );

    expect(result).toMatchObject({ written: true, considered: 1, extracted: 1 });
    expect(result.telemetry).toMatchObject({ cacheHits: 1, cacheMisses: 0 });
    expect(extractorCallCount).toBe(1);
  });

  test("a cache-hit plus cache-miss batch fails before changing graph or cache state", async () => {
    writeFile("memories/a-hit.md", {}, "Alice works with Bob.");
    extractor = () => ({ entities: ["Alice", "Bob"], relations: [{ from: "Alice", to: "Bob" }] });
    const cfg = configWithLlm({
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 1 } },
    });

    await withGraphDb("prime-mixed-cache", (db) => runGraphExtractionPass({ config: cfg, sources: sources(), db }));
    writeFile("memories/b-miss.md", {}, "Carol supports Service C.");
    const engine = cfg.engines?.index;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the index LLM engine");
    engine.apiKey = "$AKM_GRAPH_MIXED_REQUIRED_KEY";

    await withGraphDb("required-key-mixed-cache", async (db) => {
      const snapshot = () => ({
        cache: db.prepare("SELECT * FROM llm_enrichment_cache ORDER BY asset_ref, cache_variant").all(),
        files: db.prepare("SELECT * FROM graph_files ORDER BY stash_root, file_path").all(),
        entities: db.prepare("SELECT * FROM graph_file_entities ORDER BY stash_root, file_path, entity_order").all(),
        relations: db
          .prepare("SELECT * FROM graph_file_relations ORDER BY stash_root, file_path, relation_order")
          .all(),
        meta: db.prepare("SELECT * FROM graph_meta ORDER BY stash_root").all(),
      });
      const before = snapshot();
      const failure = withEnv({ AKM_GRAPH_MIXED_REQUIRED_KEY: undefined }, () =>
        runGraphExtractionPass({ config: cfg, sources: sources(), db }),
      );

      await expect(failure).rejects.toBeInstanceOf(ConfigError);
      expect(snapshot()).toEqual(before);
      expect(extractorCallCount).toBe(1);
    });
  });

  test.each([
    1, 2,
  ])("a queued stored hit cannot be acknowledged before a classified sweep cache hit is consumed (batch size %i)", async (batchSize) => {
    const queuedBody = "Alice works with Bob.";
    const sweepBody = "Carol supports Service C.";
    const queuedPath = writeFile("memories/a-queued.md", {}, queuedBody);
    const sweepPath = writeFile("memories/b-sweep.md", {}, sweepBody);
    const cfg = configWithLlm({
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: batchSize } },
    });
    extractor = (body) =>
      body.includes("Alice")
        ? { entities: ["Alice", "Bob"], relations: [{ from: "Alice", to: "Bob" }] }
        : { entities: ["Carol", "Service C"], relations: [{ from: "Carol", to: "Service C" }] };

    await withGraphDb("prime-queue-cache-race", (db) =>
      runGraphExtractionPass({ config: cfg, sources: sources(), db }),
    );
    expect(extractorCallCount).toBe(batchSize === 1 ? 2 : 1);
    const engine = cfg.engines?.index;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the index LLM engine");
    engine.apiKey = "$AKM_GRAPH_QUEUE_CACHE_RACE_REQUIRED_KEY";

    await withGraphDb("queue-cache-race", async (db) => {
      // Queue classification accepts the stored node independently of extractor
      // identity. The sweep must use its validated LLM cache entry instead.
      db.prepare("UPDATE graph_meta SET extractor_id = ? WHERE stash_root = ?").run("stale-extractor", tmpStash);
      enqueueGraphExtraction(db, tmpStash, queuedPath, computeBodyHash(queuedBody), 10);
      let invalidated = false;

      const result = await withEnv({ AKM_GRAPH_QUEUE_CACHE_RACE_REQUIRED_KEY: undefined }, () =>
        runGraphExtractionPass({
          config: cfg,
          sources: sources(),
          db,
          onProgress: (event) => {
            if (!invalidated && event.processed === 0) {
              db.prepare("DELETE FROM llm_enrichment_cache WHERE asset_ref = ?").run(sweepPath);
              invalidated = true;
            }
          },
        }),
      );

      expect(result).toMatchObject({ considered: 1, extracted: 1, written: true });
      expect(result.telemetry).toMatchObject({ cacheHits: 1, cacheMisses: 0 });
      expect(extractorCallCount).toBe(batchSize === 1 ? 2 : 1);
      const queueCount = (
        db.prepare("SELECT COUNT(*) AS n FROM graph_extraction_queue WHERE stash_root = ?").get(tmpStash) as {
          n: number;
        }
      ).n;
      expect(queueCount).toBe(0);
      const stored = loadStoredGraphSnapshot(tmpStash, db);
      expect(stored?.files.find((file) => file.path === sweepPath)?.entities).toEqual(["Carol", "Service C"]);
    });
  });

  test("a queued model extraction preserves a newer revision enqueued during dispatch", async () => {
    const originalBody = "Original body about Alice.";
    const revisedBody = "Revised body about Bob.";
    const queuedPath = writeFile("memories/queued-revision.md", {}, originalBody);
    const cfg = configWithLlm({
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 1 } },
    });

    await withGraphDb("queue-concurrent-revision", async (db) => {
      enqueueGraphExtraction(db, tmpStash, queuedPath, computeBodyHash(originalBody), 10);
      let revised = false;
      extractor = () => {
        if (!revised) {
          fs.writeFileSync(queuedPath, `---\n---\n\n${revisedBody}\n`, "utf8");
          enqueueGraphExtraction(db, tmpStash, queuedPath, computeBodyHash(revisedBody), 10);
          revised = true;
        }
        return { entities: ["Alice"], relations: [] };
      };

      await runGraphExtractionPass({
        config: cfg,
        sources: sources(),
        db,
        options: { candidatePaths: new Set() },
      });

      const queued = db
        .prepare("SELECT body_hash FROM graph_extraction_queue WHERE stash_root = ? AND file_path = ?")
        .get(tmpStash, queuedPath) as { body_hash: string };
      expect(queued.body_hash).toBe(computeBodyHash(revisedBody));
      const stored = loadStoredGraphSnapshot(tmpStash, db);
      expect(stored?.files.find((file) => file.path === queuedPath)?.bodyHash).toBe(computeBodyHash(originalBody));
    });
  });

  test("a queued model extraction does not acknowledge a revision deleted during dispatch", async () => {
    const body = "Temporary body about Alice.";
    const queuedPath = writeFile("memories/queued-deletion.md", {}, body);
    const cfg = configWithLlm({
      index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 1 } },
    });

    await withGraphDb("queue-concurrent-deletion", async (db) => {
      enqueueGraphExtraction(db, tmpStash, queuedPath, computeBodyHash(body), 10);
      extractor = () => {
        fs.rmSync(queuedPath);
        return { entities: ["Alice"], relations: [] };
      };

      await runGraphExtractionPass({
        config: cfg,
        sources: sources(),
        db,
        options: { candidatePaths: new Set() },
      });

      const queued = db
        .prepare("SELECT body_hash FROM graph_extraction_queue WHERE stash_root = ? AND file_path = ?")
        .get(tmpStash, queuedPath) as { body_hash: string };
      expect(queued.body_hash).toBe(computeBodyHash(body));

      extractor = () => {
        throw new Error("a deletion-only recovery pass dispatched an LLM request");
      };
      await runGraphExtractionPass({
        config: cfg,
        sources: sources(),
        db,
        options: { candidatePaths: new Set() },
      });
      const queueCount = (
        db.prepare("SELECT COUNT(*) AS n FROM graph_extraction_queue WHERE stash_root = ?").get(tmpStash) as {
          n: number;
        }
      ).n;
      expect(queueCount).toBe(0);
    });
  });

  test("runs when the pass is enabled and its index engine resolves", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["E"], relations: [] });
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      engines: { index: { kind: "llm", ...SAMPLE_LLM } },
      index: { defaults: { engine: "index" }, graph: { enabled: true } },
    };
    const result = await withGraphDb("both-gates-allow", (db) =>
      runGraphExtractionPass({ config: cfg, sources: sources(), db }),
    );
    expect(result.written).toBe(true);
    expect(result.considered).toBe(1);
    expect(result.extracted).toBe(1);
  });

  test("no-op cleanly when the pass is enabled but no index engine resolves", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => {
      throw new Error("must not be called when the index engine is absent");
    };
    const cfg: AkmConfig = {
      semanticSearchMode: "auto",
      index: { graph: { enabled: true } },
    };
    const result = await withGraphDb("llm-absent-third-precondition", (db) =>
      runGraphExtractionPass({ config: cfg, sources: sources(), db }),
    );
    expect(result.written).toBe(false);
    expect(result.considered).toBe(0);
    expect(result.extracted).toBe(0);
  });

  test("disabled graph pass short-circuits despite a configured index engine", async () => {
    writeFile("memories/m1.md", {}, "Body.");
    extractor = () => ({ entities: ["E"], relations: [] });
    const passOff = await withGraphDb("either-gate-pass-off", (db) =>
      runGraphExtractionPass({
        config: {
          semanticSearchMode: "auto",
          engines: { index: { kind: "llm", ...SAMPLE_LLM } },
          index: { defaults: { engine: "index" }, graph: { enabled: false } },
        },
        sources: sources(),
        db,
      }),
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
      runGraphExtractionPass({
        config: configWithLlm(),
        sources: sources(),
        db,
        reEnrich: false,
        onProgress: (event) => {
          events.push({ processed: event.processed, total: event.total, currentPath: event.currentPath });
        },
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
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
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
    expect(result.telemetry?.model).toBe("llama3.2");
    expect(result.telemetry?.promptVersion).toBe(graphExtractPromptVersion);
    expect(typeof result.telemetry?.extractionRunId).toBe("string");
    expect(result.telemetry?.batchSize).toBeGreaterThanOrEqual(1);

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
    expect(parsed.telemetry?.model).toBe("llama3.2");
    expect(parsed.telemetry?.promptVersion).toBe(graphExtractPromptVersion);
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
      runGraphExtractionPass({
        config: configWithLlm({ index: { graph: { graphExtractionIncludeTypes: ["memory", "command"] } } }),
        sources: sources(),
        db,
      }),
    );

    expect(result.considered).toBe(2);
    expect(result.extracted).toBe(2);
  });

  test("files with no extracted entities are persisted with empty status while still considered", async () => {
    writeFile("memories/m1.md", {}, "Empty graph body.");
    writeFile("memories/m2.md", {}, "Has entities.");
    extractor = (body) => {
      if (body.includes("Has entities")) return { entities: ["X"], relations: [] };
      return { entities: [], relations: [] };
    };

    const result = await withGraphDb("omit-empty-entities", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    expect(result.considered).toBe(2);
    expect(result.extracted).toBe(1);
    expect(result.written).toBe(true);

    const parsed = await withGraphDb("omit-empty-entities-read", (db) => loadStoredGraphSnapshot(tmpStash, db));
    if (!parsed) throw new Error("expected stored graph snapshot");
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files.find((file) => file.path.endsWith("m1.md"))?.status).toBe("empty");
    expect(parsed.files.find((file) => file.path.endsWith("m1.md"))?.reason).toBe("no_graph_content");
  });

  test("candidate-path refresh preserves unrelated nodes from the existing graph", async () => {
    const memoryPath = writeFile("memories/m1.md", {}, "Body about ServiceA.");
    writeFile("knowledge/k1.md", {}, "Body about ServiceB.");
    extractor = (body) => {
      if (body.includes("ServiceA")) return { entities: ["ServiceA"], relations: [] };
      return { entities: ["ServiceB"], relations: [] };
    };

    await withGraphDb("candidate-preserve-initial", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    fs.writeFileSync(memoryPath, "---\n---\n\nBody about ServiceA updated.\n", "utf8");

    extractor = (body) => {
      if (body.includes("updated")) return { entities: ["ServiceA2"], relations: [] };
      throw new Error("untouched file should be preserved from the previous graph");
    };

    const result = await withGraphDb("candidate-preserve-refresh", (db) =>
      runGraphExtractionPass({
        config: configWithLlm(),
        sources: sources(),
        db,
        reEnrich: false,
        options: { candidatePaths: new Set([memoryPath]) },
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

  test("candidate-path refresh keeps touched nodes as empty-status records when they no longer yield graph entities", async () => {
    const memoryPath = writeFile("memories/m1.md", {}, "Body about ServiceA.");
    writeFile("knowledge/k1.md", {}, "Body about ServiceB.");
    extractor = (body) => {
      if (body.includes("ServiceA")) return { entities: ["ServiceA"], relations: [] };
      return { entities: ["ServiceB"], relations: [] };
    };

    await withGraphDb("candidate-remove-initial", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    fs.writeFileSync(memoryPath, "---\n---\n\nBody about ServiceA updated again.\n", "utf8");

    extractor = (body) => {
      if (body.includes("updated again")) return { entities: [], relations: [] };
      throw new Error("untouched file should be preserved from the previous graph");
    };

    const result = await withGraphDb("candidate-remove-refresh", (db) =>
      runGraphExtractionPass({
        config: configWithLlm(),
        sources: sources(),
        db,
        reEnrich: false,
        options: { candidatePaths: new Set([memoryPath]) },
      }),
    );

    expect(result.written).toBe(true);
    const parsed = (await withGraphDb("candidate-remove-read", (db) => loadStoredGraphSnapshot(tmpStash, db))) as {
      files: Array<{ path: string; entities: string[]; status?: string; reason?: string }>;
      entities: string[];
    };
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files.find((file) => file.path === memoryPath)?.entities).toEqual([]);
    expect(parsed.files.find((file) => file.path === memoryPath)?.status).toBe("empty");
    expect(parsed.files.find((file) => file.path === memoryPath)?.reason).toBe("no_graph_content");
    expect(parsed.entities).toEqual(["ServiceB"]);
  });

  test("replaces an existing stored graph with an empty-status row when every extraction returns no entities", async () => {
    // Schema v2: graph_files.entry_id FKs entries.id. Use a single file
    // (m1.md) that is both the eligible source AND the existing graph row's
    // target — that way the prior snapshot survives the "no-op" path
    // (replaceStoredGraph never runs because extracted=0, so the existing
    // row stays).
    writeFile("memories/m1.md", {}, "Empty graph body.");
    extractor = () => ({ entities: [], relations: [] });

    const m1Path = path.join(tmpStash, "memories", "m1.md");
    await withGraphDb("existing-graph-sentinel", (db) =>
      replaceStoredGraph(db, {
        schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: tmpStash,
        files: [
          {
            path: m1Path,
            type: "memory",
            bodyHash: "sentinel-hash",
            entities: ["Sentinel"],
            relations: [],
          },
        ],
      }),
    );

    const result = await withGraphDb("existing-graph-noop", async (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    const after = await withGraphDb("existing-graph-noop-read", (db) => loadStoredGraphSnapshot(tmpStash, db));

    expect(result.considered).toBe(1);
    expect(result.extracted).toBe(0);
    expect(result.written).toBe(true);
    if (!after) throw new Error("expected existing stored graph snapshot");
    expect(after.files[0]?.entities).toEqual([]);
    expect(after.files[0]?.status).toBe("empty");
    expect(after.files[0]?.reason).toBe("no_graph_content");
  });

  test("does not extract from cache-only sources (only the primary stash)", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-cache-"));
    try {
      fs.mkdirSync(path.join(cacheDir, "memories"), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "memories", "cache.md"), "---\n---\n\nCache body about X.\n");

      writeFile("memories/m1.md", {}, "Primary body.");
      extractor = () => ({ entities: ["X"], relations: [] });

      const result = await withGraphDb("cache-only-source", (db) =>
        runGraphExtractionPass({ config: configWithLlm(), sources: [{ path: tmpStash }, { path: cacheDir }], db }),
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
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    expect(first.written).toBe(true);
    expect(extractorCallCount).toBe(1);

    extractor = () => {
      throw new Error("must not be called when prior graph node is reusable");
    };

    const second = await withGraphDb("incremental-reuse-second", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    expect(second.written).toBe(true);
    expect(second.extracted).toBe(1);
    expect(extractorCallCount).toBe(1);
  });

  test("changed file body hash invalidates prior graph node and falls back to extraction", async () => {
    const filePath = writeFile("memories/m1.md", {}, "Original body about ServiceA.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });
    await withGraphDb("hash-invalidate-first", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    expect(extractorCallCount).toBe(1);

    fs.writeFileSync(filePath, "---\n---\n\nUpdated body about ServiceB.\n", "utf8");
    extractor = () => ({ entities: ["ServiceB"], relations: [] });

    const second = await withGraphDb("hash-invalidate-second", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
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
    await withGraphDb("invalid-prior-first", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    expect(extractorCallCount).toBe(1);

    await withGraphDb("invalid-prior-corrupt", (db) => {
      const filePath = path.join(tmpStash, "memories", "m1.md");
      // body_hash is NOT NULL (and, since #624-P1, part of the composite PK
      // shared with the child tables via an ON DELETE CASCADE FK). Corrupt it
      // with a sentinel so the hash-equality check misses and the pass falls
      // back to a fresh extraction. Update all three tables together so the
      // composite FK stays satisfied.
      db.prepare("PRAGMA foreign_keys = OFF").run();
      db.prepare("UPDATE graph_files SET body_hash = '__corrupt__' WHERE stash_root = ? AND file_path = ?").run(
        tmpStash,
        filePath,
      );
      db.prepare("UPDATE graph_file_entities SET body_hash = '__corrupt__' WHERE stash_root = ? AND file_path = ?").run(
        tmpStash,
        filePath,
      );
      db.prepare(
        "UPDATE graph_file_relations SET body_hash = '__corrupt__' WHERE stash_root = ? AND file_path = ?",
      ).run(tmpStash, filePath);
      db.prepare("PRAGMA foreign_keys = ON").run();
      db.prepare("DELETE FROM llm_enrichment_cache WHERE asset_ref = ?").run(filePath);
    });

    extractor = () => ({ entities: ["ServiceC"], relations: [] });
    const second = await withGraphDb("invalid-prior-second", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    expect(second.written).toBe(true);
    expect(extractorCallCount).toBe(2);

    const repaired = (await withGraphDb("invalid-prior-read", (db) => loadStoredGraphSnapshot(tmpStash, db))) as {
      files: Array<{ entities: string[] }>;
    };
    expect(repaired.files[0]?.entities).toContain("ServiceC");
  });
});

// ── runGraphExtractionPass — R2: failed extractions must not become
//    permanent cache hits, and a systemically dead provider must not be
//    hammered indefinitely ────────────────────────────────────────────────

describe("runGraphExtractionPass — R2 failed-extraction handling", () => {
  test("a failed llm_enrichment_cache row and a failed graph node are treated as a miss and retried", async () => {
    const filePath = writeFile("memories/m1.md", {}, "Body about ServiceA.");
    extractor = () => ({ entities: ["ServiceA"], relations: [] });

    await withGraphDb("failed-cache-seed", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    expect(extractorCallCount).toBe(1);

    // Simulate the R2 outage: poison both the cache row and the persisted
    // graph node for the SAME body hash with a `status:"failed"` result —
    // exactly what a dead provider wrote for ~30,900 files on 2026-09-13.
    // Existing rows are left on disk (not deleted), only overwritten in place.
    await withGraphDb("failed-cache-poison", (db) => {
      const failedJson = JSON.stringify({ entities: [], relations: [], status: "failed", reason: "llm_error" });
      db.prepare("UPDATE llm_enrichment_cache SET result_json = ? WHERE asset_ref = ?").run(failedJson, filePath);
      db.prepare("UPDATE graph_files SET status = 'failed', reason = 'llm_error' WHERE file_path = ?").run(filePath);
      db.prepare("DELETE FROM graph_file_entities WHERE file_path = ?").run(filePath);
    });

    extractor = () => ({ entities: ["ServiceA2"], relations: [] });
    const second = await withGraphDb("failed-cache-retry", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );

    // A failed cached result must never be reused — the file is re-extracted,
    // and the FRESH successful result (not the poisoned one) lands in the
    // cache. (graph_files itself skips rewriting entities when the body hash
    // is unchanged — a pre-existing, unrelated optimization — so the cache
    // table, which always overwrites, is what this asserts on.)
    expect(extractorCallCount).toBe(2);
    expect(second.extracted).toBe(1);
    await withGraphDb("failed-cache-read", (db) => {
      const row = db.prepare("SELECT result_json FROM llm_enrichment_cache WHERE asset_ref = ?").get(filePath) as
        | { result_json: string }
        | undefined;
      expect(row).toBeDefined();
      const cached = JSON.parse(row?.result_json ?? "{}");
      expect(cached.status).toBe("extracted");
      expect(cached.entities).toEqual(["ServiceA2"]);
    });
  });

  test("a failed extraction is not written to llm_enrichment_cache", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA.");
    // Provider dies for this call: first attempt + client.ts's single
    // built-in retry both return 500.
    errorStatusQueue.push(500, 500);

    const result = await withGraphDb("no-cache-on-failure", (db) =>
      runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db }),
    );
    expect(result.considered).toBe(1);
    // The failed result IS still persisted as a graph row (existing rows are
    // never deleted/hidden) but must NOT be written into the cache table.
    await withGraphDb("no-cache-on-failure-read", (db) => {
      const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
      expect(cacheCount).toBe(0);
    });
    const graph = (await withGraphDb("no-cache-on-failure-graph", (db) => loadStoredGraphSnapshot(tmpStash, db))) as {
      files: Array<{ status?: string; reason?: string }>;
    };
    expect(graph.files[0]?.status).toBe("failed");
  });

  test("a failure-rate abort stops the run early, keeps successful partial results, and reports it in telemetry", async () => {
    for (const name of ["m1", "m2", "m3", "m4", "m5"]) writeFile(`memories/${name}.md`, {}, `Body about ${name}.`);
    extractor = () => ({ entities: ["Never"], relations: [] });
    // batchSize:1 so each file is its own `extractGraphFromBodies` dispatch —
    // the abort counts one attempt per dispatch, not per file inside a
    // shared batch (a single batched provider_error must not itself trip
    // the guard). The first 4 (of 5) eligible files fail: each dispatch is a
    // provider error, and client.ts's single built-in retry also fails — 2
    // queued statuses per file, 8 total. The 5th file must never be dispatched.
    errorStatusQueue.push(500, 500, 500, 500, 500, 500, 500, 500);

    const result = await withGraphDb("failure-rate-abort", (db) =>
      runGraphExtractionPass({
        config: configWithLlm({
          index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 1 } },
        }),
        sources: sources(),
        db,
      }),
    );

    expect(result.considered).toBe(5);
    // Only the 4 attempted-and-failed files were processed; the 5th was
    // never dispatched to the real (would-succeed) extractor.
    expect(extractorCallCount).toBe(0);
    expect(result.extracted).toBe(0);
    expect(result.telemetry?.aborted).toBe(true);
    expect(result.warnings?.some((w) => /aborted.*failure rate/i.test(w))).toBe(true);
  });
});
