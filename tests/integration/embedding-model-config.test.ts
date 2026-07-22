import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig, EmbeddingConnectionConfig } from "../../src/core/config/config";
import { setQuiet } from "../../src/core/warn";
import { _setTransformersLoaderForTests, clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import { type Cleanup, sandboxXdgConfigHome } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  overrideSeam(_setTransformersLoaderForTests, async () => ({
    pipeline: async () => {
      return async () => ({
        data: (() => {
          const vector = new Float32Array(384);
          vector[0] = 0.1;
          vector[1] = 0.2;
          vector[2] = 0.3;
          return vector;
        })(),
      });
    },
  }));
});

// ── Test 1: DEFAULT_LOCAL_MODEL constant is exported and correct ──────────

describe("DEFAULT_LOCAL_MODEL", () => {
  test("is exported and has the expected value", async () => {
    const { DEFAULT_LOCAL_MODEL } = await import("../../src/llm/embedder");
    expect(DEFAULT_LOCAL_MODEL).toBe("Xenova/bge-small-en-v1.5");
  });

  test("is a non-empty string", async () => {
    const { DEFAULT_LOCAL_MODEL } = await import("../../src/llm/embedder");
    expect(typeof DEFAULT_LOCAL_MODEL).toBe("string");
    expect(DEFAULT_LOCAL_MODEL.length).toBeGreaterThan(0);
  });
});

// ── Test 2: EmbeddingConnectionConfig accepts localModel field ────────────

describe("EmbeddingConnectionConfig localModel field", () => {
  test("accepts localModel as an optional string field", () => {
    // This is a type-level test — if it compiles, the field is accepted
    const config: EmbeddingConnectionConfig = {
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
      localModel: "Xenova/all-MiniLM-L6-v2",
    };
    expect(config.localModel).toBe("Xenova/all-MiniLM-L6-v2");
  });

  test("works without localModel (backward compatible)", () => {
    const config: EmbeddingConnectionConfig = {
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    };
    expect(config.localModel).toBeUndefined();
  });
});

// ── Test 3: embed() uses DEFAULT_LOCAL_MODEL when no config ───────────────

describe("embed model selection", () => {
  test("embed() falls back to local when no config is provided", async () => {
    const { embed } = await import("../../src/llm/embedder");
    const result = await embed("hello");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test("embed() uses localModel from config when no remote endpoint", async () => {
    const { embed } = await import("../../src/llm/embedder");
    const config: EmbeddingConnectionConfig = {
      endpoint: "",
      model: "",
      localModel: "Xenova/all-MiniLM-L6-v2",
    };
    const result = await embed("hello", config);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── Test 4: EmbeddingConnectionConfig type accepts localModel field ───────

describe("EmbeddingConnectionConfig type accepts localModel field", () => {
  test("AkmConfig embedding field accepts localModel", () => {
    // Type-system validation: verifies the interface accepts localModel
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
        localModel: "Xenova/bge-small-en-v1.5",
      },
    };
    expect(config.embedding?.localModel).toBe("Xenova/bge-small-en-v1.5");
  });

  test("old configs without localModel still work", () => {
    const config: AkmConfig = {
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
      },
    };
    expect(config.embedding?.localModel).toBeUndefined();
    // The config is valid and should not cause errors
    expect(config.embedding?.endpoint).toBe("http://localhost:11434/v1/embeddings");
    expect(config.embedding?.model).toBe("nomic-embed-text");
  });
});

// ── Test 5: Remote endpoint config still works independently ──────────────

describe("remote endpoint independence", () => {
  test("setting localModel does not affect remote endpoint behavior", async () => {
    // Create a mock embedding server
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.5, 0.6, 0.7] }],
            model: body.model,
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
          { headers: { "Content-Type": "application/json", Connection: "close" } },
        );
      },
    });

    try {
      const { embed } = await import("../../src/llm/embedder");
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}`,
        model: "remote-model",
        localModel: "Xenova/bge-small-en-v1.5",
      };

      // Remote embedding should still work — localModel should not interfere
      const result = await embed("hello world", config);
      expect(result.length).toBe(3);
      // Result should be L2-normalized
      const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 5);
    } finally {
      server.stop(true);
    }
  });

  test("remote embed does not send localModel to the API", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2] }],
            model: "test",
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
          { headers: { "Content-Type": "application/json", Connection: "close" } },
        );
      },
    });

    try {
      const { embed } = await import("../../src/llm/embedder");
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}`,
        model: "remote-model",
        localModel: "Xenova/bge-small-en-v1.5",
      };
      await embed("test", config);

      // The request body should use `model` (not localModel) and should
      // not include localModel as a field
      expect(capturedBody).toBeDefined();
      expect(capturedBody?.model).toBe("remote-model");
      expect(capturedBody).not.toHaveProperty("localModel");
    } finally {
      server.stop(true);
    }
  });
});

// ── Test 6: Dimension consistency ─────────────────────────────────────────

describe("dimension consistency on model change", () => {
  test("cosineSimilarity returns 0 for dimension mismatch (different models produce different dims)", async () => {
    const { cosineSimilarity } = await import("../../src/llm/embedder");
    const originalWarn = console.warn;
    const warnings: string[] = [];
    // Simulate a 384-dim vector (old model) vs 768-dim vector (new model)
    const vec384 = Array(384).fill(1 / Math.sqrt(384));
    const vec768 = Array(768).fill(1 / Math.sqrt(768));
    // setQuiet(false): harness defaults to quiet=true; opt into noisy mode so
    // warn() calls from cosineSimilarity reach the patched console.warn.
    setQuiet(false);
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      const similarity = cosineSimilarity(vec384, vec768);
      expect(similarity).toBe(0);
      expect(warnings.some((warning) => warning.includes("vector dimension mismatch"))).toBe(true);
    } finally {
      console.warn = originalWarn;
      setQuiet(true); // restore harness default
    }
  });

  test("db dimension mismatch triggers vec table recreation", async () => {
    // This is already tested in db.test.ts but we verify the concept:
    // when embedding dimensions change (due to model change), the
    // database handles it by recreating the vec table
    const { openIndexDatabase, closeDatabase } = await import("../../src/storage/repositories/index-connection");
    const { getMeta } = await import("../../src/storage/repositories/index-meta-repository");
    const { isVecAvailable } = await import("../../src/storage/repositories/index-vec-repository");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-embed-model-"));
    const dbPath = path.join(tmpDir, "test.db");

    try {
      // Open with old model dimension (384 = all-MiniLM-L6-v2)
      let db = openIndexDatabase(dbPath, { embeddingDim: 384 });
      if (isVecAvailable(db)) {
        expect(getMeta(db, "embeddingDim")).toBe("384");
      }
      closeDatabase(db);

      // Open with new model dimension (384 = bge-small-en-v1.5, same dims)
      // Both models happen to be 384-dim, so no recreation needed
      db = openIndexDatabase(dbPath, { embeddingDim: 384 });
      if (isVecAvailable(db)) {
        expect(getMeta(db, "embeddingDim")).toBe("384");
      }
      closeDatabase(db);

      // But if someone uses a different-dimension model (e.g. 768), it should recreate
      db = openIndexDatabase(dbPath, { embeddingDim: 768 });
      if (isVecAvailable(db)) {
        expect(getMeta(db, "embeddingDim")).toBe("768");
      }
      closeDatabase(db);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Test 7: Config parsing roundtrip for localModel via loadConfig ────────

describe("config file parsing for localModel", () => {
  let cfgCleanup: Cleanup = () => {};
  let cfgDir = "";

  beforeEach(() => {
    const cfgResult = sandboxXdgConfigHome();
    cfgDir = cfgResult.dir;
    cfgCleanup = cfgResult.cleanup;
  });

  afterEach(() => {
    cfgCleanup();
    cfgCleanup = () => {};
    cfgDir = "";
  });

  test("parseEmbeddingConfig preserves localModel from raw config object", async () => {
    const { loadConfig } = await import("../../src/core/config/config");

    const configData = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
        localModel: "Xenova/bge-small-en-v1.5",
      },
    };

    // Create the akm subdirectory structure expected by getConfigPath
    const akmDir = path.join(cfgDir, "akm");
    fs.mkdirSync(akmDir, { recursive: true });
    fs.writeFileSync(path.join(akmDir, "config.json"), JSON.stringify(configData));

    // Actually call loadConfig to test the parsing path
    const config = loadConfig();
    expect(config.embedding).toBeDefined();
    expect(config.embedding?.localModel).toBe("Xenova/bge-small-en-v1.5");
    expect(config.embedding?.endpoint).toBe("http://localhost:11434/v1/embeddings");
    expect(config.embedding?.model).toBe("nomic-embed-text");
  });

  test("local-only config: endpoint and model are undefined when only localModel is set", async () => {
    const { loadConfig } = await import("../../src/core/config/config");

    const configData = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      embedding: {
        localModel: "Xenova/bge-small-en-v1.5",
      },
    };

    const akmDir = path.join(cfgDir, "akm");
    fs.mkdirSync(akmDir, { recursive: true });
    fs.writeFileSync(path.join(akmDir, "config.json"), JSON.stringify(configData));

    const config = loadConfig();
    expect(config.embedding).toBeDefined();
    expect(config.embedding?.localModel).toBe("Xenova/bge-small-en-v1.5");
    // sentinel "" injection was removed in 393de77; fields stay undefined
    expect(config.embedding?.endpoint).toBeUndefined();
    expect(config.embedding?.model).toBeUndefined();
  });
});

// ── Test 8: endpoint+localModel+no-model warns and uses local-only ────────

describe("parseEmbeddingConfig edge cases", () => {
  let cfgCleanup: Cleanup = () => {};
  let cfgDir = "";

  beforeEach(() => {
    const cfgResult = sandboxXdgConfigHome();
    cfgDir = cfgResult.dir;
    cfgCleanup = cfgResult.cleanup;
  });

  afterEach(() => {
    cfgCleanup();
    cfgCleanup = () => {};
    cfgDir = "";
  });

  test("endpoint+localModel without model passes through as-is (no sentinel, no warn)", async () => {
    // warn-and-drop preprocessing was removed in 393de77; partial embedding
    // configs are now passed through by Zod as-is.
    const { loadConfig } = await import("../../src/core/config/config");

    const configData = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "http://localhost:11434/v1/embeddings",
        localModel: "Xenova/bge-small-en-v1.5",
        // Note: model is intentionally missing
      },
    };

    const akmDir = path.join(cfgDir, "akm");
    fs.mkdirSync(akmDir, { recursive: true });
    fs.writeFileSync(path.join(akmDir, "config.json"), JSON.stringify(configData));

    const config = loadConfig();
    expect(config.embedding).toBeDefined();
    expect(config.embedding?.localModel).toBe("Xenova/bge-small-en-v1.5");
    expect(config.embedding?.endpoint).toBe("http://localhost:11434/v1/embeddings");
    // model stays undefined since it was not set
    expect(config.embedding?.model).toBeUndefined();
  });

  test("endpoint-only config passes through (no undefined coercion)", async () => {
    // The old parseEmbeddingConfig returned undefined when only endpoint was
    // set (no model/localModel). That helper was deleted in 393de77; the Zod
    // schema now accepts any combination of optional fields.
    const { loadConfig } = await import("../../src/core/config/config");

    const configData = {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      embedding: {
        endpoint: "http://localhost:11434/v1/embeddings",
        // No model, no localModel
      },
    };

    const akmDir = path.join(cfgDir, "akm");
    fs.mkdirSync(akmDir, { recursive: true });
    fs.writeFileSync(path.join(akmDir, "config.json"), JSON.stringify(configData));

    const config = loadConfig();
    expect(config.embedding).toBeDefined();
    expect(config.embedding?.endpoint).toBe("http://localhost:11434/v1/embeddings");
    expect(config.embedding?.model).toBeUndefined();
    expect(config.embedding?.localModel).toBeUndefined();
  });
});
