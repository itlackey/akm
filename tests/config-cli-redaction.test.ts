import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "./_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv, writeSandboxConfig } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function makeTempDir(): string {
  const d = makeSandboxDir("akm-config-redaction-");
  disposers.push(d);
  return d.dir;
}

function freshEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    AKM_BUNDLE_DIR: makeTempDir(),
    HOME: makeTempDir(),
    XDG_CONFIG_HOME: makeTempDir(),
    XDG_CACHE_HOME: makeTempDir(),
    XDG_DATA_HOME: makeTempDir(),
    XDG_STATE_HOME: makeTempDir(),
    ...overrides,
  };
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

describe("config command apiKey redaction", () => {
  test("config list/get show symbolic refs but never env-sourced values", async () => {
    const secretLlm = "sk-llm-secret-123";
    const secretEmbed = "sk-embed-secret-456";
    const env = freshEnv({ AKM_LLM_API_KEY: secretLlm, AKM_EMBED_API_KEY: secretEmbed });

    const outputs = await withEnv(env, async () => {
      writeSandboxConfig({
        semanticSearchMode: "off",
        embedding: {
          endpoint: "https://emb.example.test/v1/embeddings",
          model: "embed-model",
          apiKey: "$AKM_EMBED_API_KEY",
        },
        connections: {
          default: {
            endpoint: "https://llm.example.test/v1",
            models: { fast: "chat-model" },
            apiKey: "$AKM_LLM_API_KEY",
          },
        },
      });

      const list = await runCliCapture(["config", "list"]);
      const embedding = await runCliCapture(["config", "get", "embedding"]);
      const llm = await runCliCapture(["config", "get", "connections.default"]);
      const engines = await runCliCapture(["config", "get", "connections"]);
      const llmApiKey = await runCliCapture(["config", "get", "connections.default.apiKey"]);

      return { list, embedding, llm, engines, llmApiKey };
    });

    for (const result of Object.values(outputs)) {
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(secretLlm);
      expect(result.stdout).not.toContain(secretEmbed);
    }

    const list = JSON.parse(outputs.list.stdout) as Record<string, unknown>;
    const embedding = JSON.parse(outputs.embedding.stdout) as Record<string, unknown>;
    const llm = JSON.parse(outputs.llm.stdout) as Record<string, unknown>;
    const engines = JSON.parse(outputs.engines.stdout) as Record<string, unknown>;
    const llmApiKey = JSON.parse(outputs.llmApiKey.stdout);

    expect(JSON.stringify(list)).toContain("$AKM_LLM_API_KEY");
    expect(JSON.stringify(list)).toContain("$AKM_EMBED_API_KEY");
    expect(embedding.apiKey).toBe("$AKM_EMBED_API_KEY");
    expect(llm.apiKey).toBe("$AKM_LLM_API_KEY");
    expect(JSON.stringify(engines)).toContain("$AKM_LLM_API_KEY");
    expect(llmApiKey).toBe("$AKM_LLM_API_KEY");
  });
});

// ── `config get --show-source` ────────────────────────────────────────

describe("config get --show-source", () => {
  test("reports local and default sources", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      writeSandboxConfig({ semanticSearchMode: "auto" });

      const local = await runCliCapture(["config", "get", "semanticSearchMode", "--show-source"]);
      const fallback = await runCliCapture(["config", "get", "output.format", "--show-source"]);
      return { local, fallback };
    });

    for (const result of Object.values(outputs)) expect(result.code).toBe(0);

    expect(JSON.parse(outputs.local.stdout)).toMatchObject({ value: "auto", source: "local" });
    expect(JSON.parse(outputs.fallback.stdout)).toMatchObject({ value: "json", source: "default" });
  });

  test("omitting --show-source keeps the bare value shape", async () => {
    const env = freshEnv();
    const result = await withEnv(env, async () => {
      writeSandboxConfig({ semanticSearchMode: "auto" });
      return runCliCapture(["config", "get", "semanticSearchMode"]);
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("auto");
  });
});

// ── `config diff` ─────────────────────────────────────────────────────

describe("config diff", () => {
  test("lists differing leaves, with a literal apiKey on either side never read, never shown", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "other.json"),
        JSON.stringify({
          connections: {
            fast: {
              endpoint: "https://api.example.test/v1",
              models: { fast: "other-model" },
              apiKey: "sk-literal-secret-other",
            },
          },
        }),
      );
      writeSandboxConfig({
        connections: {
          fast: {
            endpoint: "https://api.example.test/v1",
            models: { fast: "local-model" },
            apiKey: "sk-literal-secret-local",
          },
        },
      });

      return runCliCapture(["config", "diff", path.join(configDir, "other.json")]);
    });

    expect(outputs.code).toBe(0);
    expect(outputs.stdout).not.toContain("sk-literal-secret-local");
    expect(outputs.stdout).not.toContain("sk-literal-secret-other");

    const parsed = JSON.parse(outputs.stdout) as { rows: Array<{ path: string; local: unknown; other: unknown }> };
    const modelRow = parsed.rows.find((row) => row.path === "connections.fast.models.fast");
    expect(modelRow).toEqual({ path: "connections.fast.models.fast", local: "local-model", other: "other-model" });
    // A literal apiKey is read as absent on both sides, so it never appears as its own diff row.
    expect(parsed.rows.some((row) => row.path === "connections.fast.apiKey")).toBe(false);
    expect(parsed.rows).toEqual(parsed.rows.slice().sort((a, b) => a.path.localeCompare(b.path)));
  });

  test("a file that does not exist is an error naming it", async () => {
    const env = freshEnv();

    const result = await withEnv(env, async () => {
      writeSandboxConfig({});
      return runCliCapture(["config", "diff", path.join(env.XDG_CONFIG_HOME as string, "akm", "missing.json")]);
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing.json");
  });

  test("identical configs produce empty rows", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      const shared = { semanticSearchMode: "auto" as const };
      fs.writeFileSync(path.join(configDir, "same.json"), JSON.stringify(shared));
      writeSandboxConfig(shared);

      return runCliCapture(["config", "diff", path.join(configDir, "same.json")]);
    });

    expect(outputs.code).toBe(0);
    const parsed = JSON.parse(outputs.stdout) as { rows: unknown[] };
    expect(parsed.rows).toEqual([]);
  });

  test("diff --detail agent carries rows without a results alias", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "other.json"), JSON.stringify({ semanticSearchMode: "auto" }));
      writeSandboxConfig({ semanticSearchMode: "off" });

      return runCliCapture(["config", "diff", path.join(configDir, "other.json"), "--detail", "agent"]);
    });

    expect(outputs.code).toBe(0);
    const parsed = JSON.parse(outputs.stdout) as { rows: unknown[]; results?: unknown };
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed).not.toHaveProperty("results");
  });
});
