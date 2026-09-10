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
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        embedding: {
          endpoint: "https://emb.example.test/v1/embeddings",
          model: "embed-model",
          apiKey: "$AKM_EMBED_API_KEY",
        },
        engines: {
          default: {
            kind: "llm",
            endpoint: "https://llm.example.test/v1/chat/completions",
            model: "chat-model",
            apiKey: "$AKM_LLM_API_KEY",
          },
        },
        defaults: { llmEngine: "default" },
      });

      const list = await runCliCapture(["config", "list"]);
      const embedding = await runCliCapture(["config", "get", "embedding"]);
      const llm = await runCliCapture(["config", "get", "engines.default"]);
      const engines = await runCliCapture(["config", "get", "engines"]);
      const llmApiKey = await runCliCapture(["config", "get", "engines.default.apiKey"]);

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

// ── `config get --show-source` (#945) ────────────────────────────────────────

describe("config get --show-source", () => {
  test("reports local, extends:<ref>, and default sources", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "base.json"),
        JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 21 }),
      );
      writeSandboxConfig({
        configVersion: "0.9.0",
        extends: "./base.json",
        semanticSearchMode: "auto",
      });

      const local = await runCliCapture(["config", "get", "semanticSearchMode", "--show-source"]);
      const inherited = await runCliCapture(["config", "get", "archiveRetentionDays", "--show-source"]);
      const fallback = await runCliCapture(["config", "get", "output.format", "--show-source"]);
      return { local, inherited, fallback };
    });

    for (const result of Object.values(outputs)) expect(result.code).toBe(0);

    expect(JSON.parse(outputs.local.stdout)).toMatchObject({ value: "auto", source: "local" });
    expect(JSON.parse(outputs.inherited.stdout)).toMatchObject({ value: 21, source: "extends:./base.json" });
    expect(JSON.parse(outputs.fallback.stdout)).toMatchObject({ value: "json", source: "default" });
  });

  test("omitting --show-source keeps the bare value shape", async () => {
    const env = freshEnv();
    const result = await withEnv(env, async () => {
      writeSandboxConfig({ configVersion: "0.9.0", semanticSearchMode: "auto" });
      return runCliCapture(["config", "get", "semanticSearchMode"]);
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("auto");
  });
});

// ── `config unset` refuses an extends-inherited key (#945) ──────────────────

describe("config unset against an extends-inherited key", () => {
  test("rejects unsetting a key only the extends base supplies", async () => {
    const env = freshEnv();

    const result = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "base.json"),
        JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 21 }),
      );
      writeSandboxConfig({ configVersion: "0.9.0", extends: "./base.json" });

      return runCliCapture(["config", "unset", "archiveRetentionDays"]);
    });

    expect(result.code).toBe(2);
    const error = JSON.parse(result.stderr) as { ok: boolean; error: string; code?: string };
    expect(error.ok).toBe(false);
    expect(error.error).toContain("archiveRetentionDays");
    expect(error.error).toContain("extends:./base.json");

    // The value is unchanged: unset never silently no-oped, and the local
    // file was never touched.
    const after = await withEnv(env, () => runCliCapture(["config", "get", "archiveRetentionDays"]));
    expect(JSON.parse(after.stdout)).toBe(21);
  });

  test("still unsets a key the local file itself sets, even with extends active", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "base.json"),
        JSON.stringify({ configVersion: "0.9.0", archiveRetentionDays: 21 }),
      );
      writeSandboxConfig({ configVersion: "0.9.0", extends: "./base.json", semanticSearchMode: "auto" });

      const unset = await runCliCapture(["config", "unset", "semanticSearchMode"]);
      const after = await runCliCapture(["config", "get", "semanticSearchMode"]);
      return { unset, after };
    });

    expect(outputs.unset.code).toBe(0);
    expect(outputs.after.code).toBe(0);
    // semanticSearchMode falls back to its schema default once no layer sets it.
    expect(JSON.parse(outputs.after.stdout)).toBe("off");
  });
});

// ── `config diff` (#945) ─────────────────────────────────────────────────────

describe("config diff", () => {
  test("lists differing leaves with a redacted literal apiKey on both sides", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "other.json"),
        JSON.stringify({
          configVersion: "0.9.0",
          engines: {
            fast: {
              kind: "llm",
              endpoint: "https://api.example.test/v1/chat/completions",
              model: "other-model",
              apiKey: "sk-literal-secret-other",
            },
          },
        }),
      );
      writeSandboxConfig({
        configVersion: "0.9.0",
        engines: {
          fast: {
            kind: "llm",
            endpoint: "https://api.example.test/v1/chat/completions",
            model: "local-model",
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
    const modelRow = parsed.rows.find((row) => row.path === "engines.fast.model");
    expect(modelRow).toEqual({ path: "engines.fast.model", local: "local-model", other: "other-model" });
    // The literal apiKey field is dropped by redaction on both sides, so it
    // never appears as its own diff row.
    expect(parsed.rows.some((row) => row.path === "engines.fast.apiKey")).toBe(false);
    expect(parsed.rows).toEqual(parsed.rows.slice().sort((a, b) => a.path.localeCompare(b.path)));
  });

  test("identical configs produce empty rows", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      const shared = { configVersion: "0.9.0" as const, semanticSearchMode: "auto" as const };
      fs.writeFileSync(path.join(configDir, "same.json"), JSON.stringify(shared));
      writeSandboxConfig(shared);

      return runCliCapture(["config", "diff", path.join(configDir, "same.json")]);
    });

    expect(outputs.code).toBe(0);
    const parsed = JSON.parse(outputs.stdout) as { rows: unknown[] };
    expect(parsed.rows).toEqual([]);
  });

  test("diff --shape agent still exposes the results alias", async () => {
    const env = freshEnv();

    const outputs = await withEnv(env, async () => {
      const configDir = path.join(env.XDG_CONFIG_HOME as string, "akm");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "other.json"),
        JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "auto" }),
      );
      writeSandboxConfig({ configVersion: "0.9.0", semanticSearchMode: "off" });

      return runCliCapture(["config", "diff", path.join(configDir, "other.json"), "--shape", "agent"]);
    });

    expect(outputs.code).toBe(0);
    const parsed = JSON.parse(outputs.stdout) as { rows: unknown[]; results: unknown[] };
    expect(parsed.results).toEqual(parsed.rows);
  });
});
