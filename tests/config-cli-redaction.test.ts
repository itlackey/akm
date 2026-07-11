import { afterAll, describe, expect, test } from "bun:test";
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
    AKM_STASH_DIR: makeTempDir(),
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
  test("config list/show/get show symbolic refs but never env-sourced values", async () => {
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

      const list = await runCliCapture(["--json", "config", "list"]);
      const show = await runCliCapture(["--json", "config", "show"]);
      const embedding = await runCliCapture(["--json", "config", "get", "embedding"]);
      const llm = await runCliCapture(["--json", "config", "get", "engines.default"]);
      const engines = await runCliCapture(["--json", "config", "get", "engines"]);
      const llmApiKey = await runCliCapture(["--json", "config", "get", "engines.default.apiKey"]);

      return { list, show, embedding, llm, engines, llmApiKey };
    });

    for (const result of Object.values(outputs)) {
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain(secretLlm);
      expect(result.stdout).not.toContain(secretEmbed);
    }

    const list = JSON.parse(outputs.list.stdout) as Record<string, unknown>;
    const show = JSON.parse(outputs.show.stdout) as Record<string, unknown>;
    const embedding = JSON.parse(outputs.embedding.stdout) as Record<string, unknown>;
    const llm = JSON.parse(outputs.llm.stdout) as Record<string, unknown>;
    const engines = JSON.parse(outputs.engines.stdout) as Record<string, unknown>;
    const llmApiKey = JSON.parse(outputs.llmApiKey.stdout);

    expect(JSON.stringify(list)).toContain("$AKM_LLM_API_KEY");
    expect(JSON.stringify(show)).toContain("$AKM_EMBED_API_KEY");
    expect(embedding.apiKey).toBe("$AKM_EMBED_API_KEY");
    expect(llm.apiKey).toBe("$AKM_LLM_API_KEY");
    expect(JSON.stringify(engines)).toContain("$AKM_LLM_API_KEY");
    expect(llmApiKey).toBe("$AKM_LLM_API_KEY");
  });
});
