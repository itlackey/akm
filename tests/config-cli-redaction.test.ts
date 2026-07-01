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
  test("config list/show/get omit env-sourced apiKey values and fields", async () => {
    const secretLlm = "sk-llm-secret-123";
    const secretEmbed = "sk-embed-secret-456";
    const env = freshEnv({ AKM_LLM_API_KEY: secretLlm, AKM_EMBED_API_KEY: secretEmbed });

    const outputs = await withEnv(env, async () => {
      writeSandboxConfig({
        semanticSearchMode: "off",
        embedding: {
          endpoint: "https://emb.example.test/v1/embeddings",
          model: "embed-model",
        },
        profiles: {
          llm: {
            default: {
              endpoint: "https://llm.example.test/v1/chat/completions",
              model: "chat-model",
            },
          },
        },
        defaults: { llm: "default" },
      });

      const list = await runCliCapture(["--json", "config", "list"]);
      const show = await runCliCapture(["--json", "config", "show"]);
      const embedding = await runCliCapture(["--json", "config", "get", "embedding"]);
      const llm = await runCliCapture(["--json", "config", "get", "llm"]);
      const profiles = await runCliCapture(["--json", "config", "get", "profiles"]);
      const llmApiKey = await runCliCapture(["--json", "config", "get", "llm.apiKey"]);

      return { list, show, embedding, llm, profiles, llmApiKey };
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
    const profiles = JSON.parse(outputs.profiles.stdout) as Record<string, unknown>;
    const llmApiKey = JSON.parse(outputs.llmApiKey.stdout);

    expect(JSON.stringify(list)).not.toContain("apiKey");
    expect(JSON.stringify(show)).not.toContain("apiKey");
    expect(JSON.stringify(embedding)).not.toContain("apiKey");
    expect(JSON.stringify(llm)).not.toContain("apiKey");
    expect(JSON.stringify(profiles)).not.toContain("apiKey");
    expect(llmApiKey).toBeNull();
  });
});
