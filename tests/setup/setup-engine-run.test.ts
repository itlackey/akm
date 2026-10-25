// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm setup --yes` and its flags, end to end through the config it writes:
 * the flags answer the questions they cover, the detected default answers the
 * rest, a rerun keeps what the user already chose, and no key ever lands in the
 * config or in anything printed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setAkmInitForTests } from "../../src/commands/sources/init";
import { resetConfigCache } from "../../src/core/config/config";
import { getConfigPath } from "../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { _setAgentDetectForTests } from "../../src/integrations/agent";
import { type EngineFlags, parseEngineFlags, type RawEngineFlags } from "../../src/setup/engine-flags";
import { runSetupFromConfig, runSetupWithDefaults, type SetupSummary } from "../../src/setup/setup";
import {
  type IsolatedAkmStorage,
  withEnv,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;
let warnings: string[];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  warnings = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  overrideSeam(_setAkmInitForTests, async (options?: { dir?: string }) => ({
    bundleDir: options?.dir ?? storage.stashDir,
    created: true,
    configPath: getConfigPath(),
    defaultBundleUpdated: true,
  }));
  overrideSeam(_setAgentDetectForTests, { detectAgentCliProfiles: () => [] });
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  _resetWarnOnceForTests();
  storage.cleanup();
});

const flags = (raw: RawEngineFlags): EngineFlags => parseEngineFlags(raw);
const written = (): Record<string, unknown> => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
const credentialsPath = () => path.join(path.dirname(getConfigPath()), "credentials.json");
const claudeInstalled = () =>
  overrideSeam(_setAgentDetectForTests, {
    detectAgentCliProfiles: () => [
      { name: "claude", bin: "claude", available: true, resolvedPath: "/usr/local/bin/claude" },
      { name: "codex", bin: "codex", available: true, resolvedPath: "/usr/local/bin/codex" },
    ],
  });

/** An endpoint at `base` listing `models`, recording the key each request carried; every other URL is unreachable. */
function endpoint(base: string, models: string[]) {
  const keys: (string | null)[] = [];
  const serve = <T>(run: () => Promise<T>) =>
    withMockedFetch(run, (url, init) => {
      if (url !== `${base}/models`) throw new Error("unreachable");
      keys.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ data: models.map((id) => ({ id })) });
    });
  return { keys, serve };
}

const MODELS = ["qwen3-8b", "nomic-embed-text", "qwen3-32b"];
const run = (raw: RawEngineFlags = {}, extra: { noProbe?: boolean } = {}) =>
  runSetupWithDefaults({ noInit: true, flags: flags(raw), ...extra });

describe("akm setup --endpoint --yes", () => {
  test("the standard quick start: one connection named default, one model per alias, nothing else", async () => {
    const server = endpoint("http://localhost:11434/v1", MODELS);

    const summary = await server.serve(() => run({ endpoint: "http://localhost:11434/v1" }));

    const saved = written();
    expect(saved.connections).toEqual({
      default: {
        endpoint: "http://localhost:11434/v1",
        models: { fast: "qwen3-8b", balanced: "qwen3-8b", reasoning: "qwen3-8b" },
      },
    });
    expect("harnesses" in saved).toBe(false);
    expect(summary.runs).toEqual({
      modelCalls: 'connection "default" (qwen3-8b)',
      agentWork: 'akm\'s own runtime over connection "default" (qwen3-8b)',
      // The endpoint lists an embedding model, which --yes turns on.
      embeddings: 'nomic-embed-text on connection "default"',
    });
    expect(saved.embedding).toEqual({ model: "nomic-embed-text" });
    expect(saved.semanticSearchMode).toBe("auto");
  });

  test("--api-key-env writes a $VAR reference, sends the variable's value to list models, and prints no key", async () => {
    const server = endpoint("https://api.example.test/v1", MODELS);
    const secret = "sk-from-the-environment";

    const summary = await withEnv({ EXAMPLE_KEY: secret }, () =>
      server.serve(() => run({ endpoint: "https://api.example.test/v1", apiKeyEnv: "EXAMPLE_KEY" })),
    );

    expect((written().connections as Record<string, { apiKey?: string }>).default?.apiKey).toBe("$EXAMPLE_KEY");
    expect(server.keys).toEqual([`Bearer ${secret}`]);
    expect(fs.existsSync(credentialsPath())).toBe(false);
    expect(fs.readFileSync(getConfigPath(), "utf8")).not.toContain(secret);
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(warnings.join("\n")).not.toContain(secret);
  });

  test("--name adds a further connection and leaves the default as it was", async () => {
    const server = endpoint("https://cloud.example.test/v1", ["cloud-model"]);
    writeSandboxConfig({
      semanticSearchMode: "off",
      connections: { default: { endpoint: "http://localhost:11434/v1", models: { fast: "local" } } },
    });
    resetConfigCache();

    await server.serve(() => run({ endpoint: "https://cloud.example.test/v1", name: "cloud" }));

    const connections = written().connections as Record<string, { endpoint: string; models?: Record<string, string> }>;
    expect(connections.default).toEqual({ endpoint: "http://localhost:11434/v1", models: { fast: "local" } });
    expect(connections.cloud?.endpoint).toBe("https://cloud.example.test/v1");
    expect(connections.cloud?.models).toEqual({
      fast: "cloud-model",
      balanced: "cloud-model",
      reasoning: "cloud-model",
    });
  });

  test("a rerun against the same endpoint keeps the alias picks the connection already has", async () => {
    const server = endpoint("http://localhost:11434/v1", MODELS);
    const models = {
      fast: "qwen3-8b",
      balanced: "qwen3-32b",
      reasoning: { model: "qwen3-32b", reasoning_effort: "high" },
      coder: "qwen3-coder",
    };
    writeSandboxConfig({
      semanticSearchMode: "off",
      connections: { default: { endpoint: "http://localhost:11434/v1", timeoutMs: 900000, models } },
    });
    resetConfigCache();

    await server.serve(() => run({ endpoint: "http://localhost:11434/v1" }));

    expect(written().connections).toEqual({
      default: { endpoint: "http://localhost:11434/v1", timeoutMs: 900000, models },
    });
  });

  test("a rerun over a config with its own embedding changes neither the block nor semantic search", async () => {
    const server = endpoint("http://localhost:11434/v1", MODELS);
    const embedding = { endpoint: "http://embed.example.test/v1", model: "my-own-embedder", dimension: 768 };
    writeSandboxConfig({
      semanticSearchMode: "off",
      connections: { default: { endpoint: "http://localhost:11434/v1", models: { fast: "qwen3-8b" } } },
      embedding,
    });
    resetConfigCache();

    await server.serve(() => run({ endpoint: "http://localhost:11434/v1" }));

    expect(written().embedding).toEqual(embedding);
    expect(written().semanticSearchMode).toBe("off");
  });

  test("a rerun that finds no embedding block still leaves semantic search as the user set it", async () => {
    const server = endpoint("http://localhost:11434/v1", MODELS);
    writeSandboxConfig({
      semanticSearchMode: "off",
      connections: { default: { endpoint: "http://localhost:11434/v1", models: { fast: "qwen3-8b" } } },
    });
    resetConfigCache();

    await server.serve(() => run({ endpoint: "http://localhost:11434/v1" }));

    expect(written().semanticSearchMode).toBe("off");
    expect("embedding" in written()).toBe(false);
  });

  test("--name adds a further connection without taking an embedding model only it lists", async () => {
    const server = endpoint("https://cloud.example.test/v1", ["cloud-model", "cloud-embed"]);
    writeSandboxConfig({
      semanticSearchMode: "off",
      connections: { default: { endpoint: "http://localhost:11434/v1", models: { fast: "local" } } },
    });
    resetConfigCache();

    await server.serve(() => run({ endpoint: "https://cloud.example.test/v1", name: "cloud" }));

    expect("embedding" in written()).toBe(false);
    expect(written().semanticSearchMode).toBe("off");
  });

  test("a second identical run writes the same config", async () => {
    const server = endpoint("http://localhost:11434/v1", MODELS);

    await server.serve(() => run({ endpoint: "http://localhost:11434/v1", embedding: "off" }));
    const first = written();
    await server.serve(() => run({ endpoint: "http://localhost:11434/v1", embedding: "off" }));

    expect(written()).toEqual(first);
  });

  test("a connection that has no model yet is reported as that, with how to name one", async () => {
    const summary = await run({ endpoint: "http://localhost:11434/v1" }, { noProbe: true });

    for (const said of [summary.runs.modelCalls, summary.runs.agentWork]) {
      expect(said).toContain('Connection "default" lists no models');
      expect(said).toContain("akm models set");
      expect(said).not.toContain("no connection or harness is configured");
    }
  });

  test("the same is said when the endpoint would not list its models", async () => {
    const summary = await withMockedFetch(
      () => run({ endpoint: "https://api.example.test/v1" }),
      () => new Response("denied", { status: 401 }),
    );
    expect(summary.runs.modelCalls).toContain("akm models set");
  });

  test("--no-probe contacts nothing: the connection is written with the models it already has", async () => {
    const server = endpoint("http://localhost:11434/v1", MODELS);

    await server.serve(() => run({ endpoint: "http://localhost:11434/v1" }, { noProbe: true }));

    expect(server.keys).toEqual([]);
    expect(written().connections).toEqual({ default: { endpoint: "http://localhost:11434/v1" } });
  });

  test("an endpoint that cannot list its models is written without models, with a warning", async () => {
    await withMockedFetch(
      () => run({ endpoint: "https://api.example.test/v1" }),
      () => new Response("denied", { status: 401 }),
    );

    expect(written().connections).toEqual({ default: { endpoint: "https://api.example.test/v1" } });
    expect(warnings.join("\n")).toContain("Could not list models from https://api.example.test/v1 (HTTP 401)");
  });
});

describe("akm setup --yes defaults", () => {
  test("every detected harness is enabled and the first is the default", async () => {
    claudeInstalled();

    const summary = await run();

    expect(written().harnesses).toEqual({ default: { platform: "claude" }, codex: {} });
    expect(summary.runs.agentWork).toContain('harness "default"');
    // Claude can run read-only, so it takes the model calls and no connection is looked for.
    expect(summary.runs.modelCalls).toContain('harness "default"');
    expect(summary.runs.modelCalls).toContain("read-only");
    expect("connections" in written()).toBe(false);
  });

  test("a detected local server becomes the connection when no harness takes the model calls", async () => {
    const server = endpoint("http://localhost:1234/v1", MODELS);
    const localOnly = (url: string, init?: RequestInit) => {
      if (url === "http://localhost:1234/v1/models") return Response.json({ data: MODELS.map((id) => ({ id })) });
      throw new Error(`unreachable ${init ? "" : url}`);
    };

    await withMockedFetch(() => run(), localOnly);

    expect((written().connections as Record<string, { endpoint: string }>).default?.endpoint).toBe(
      "http://localhost:1234/v1",
    );
    expect(server.keys).toEqual([]);
  });

  test("with nothing detected and nothing flagged, no engine is configured and the run says so", async () => {
    const summary = await run();

    const saved = written();
    expect("connections" in saved).toBe(false);
    expect("harnesses" in saved).toBe(false);
    expect(summary.runs.modelCalls).toContain("off");
    expect(summary.runs.agentWork).toContain("off");
  });

  test("harnesses the config already has are left alone", async () => {
    claudeInstalled();
    writeSandboxConfig({ semanticSearchMode: "off", harnesses: { codex: { bin: "/opt/codex" } } });
    resetConfigCache();

    await run();

    expect(written().harnesses).toEqual({ codex: { bin: "/opt/codex" } });
  });
});

describe("akm setup --harness", () => {
  test("enables the named platforms, the first the default, whether or not they are installed", async () => {
    const summary = await run({ harness: "opencode,claude" });

    expect(written().harnesses).toEqual({ default: { platform: "opencode" }, claude: {} });
    expect(warnings.join("\n")).toContain("opencode was not found on PATH; enabling it anyway");
    expect(summary.runs.agentWork).toContain('harness "default"');
  });

  test("adds to the harnesses already enabled instead of replacing them", async () => {
    writeSandboxConfig({ semanticSearchMode: "off", harnesses: { codex: { bin: "/opt/codex" } } });
    resetConfigCache();

    await run({ harness: "claude" });

    expect(written().harnesses).toEqual({ default: { platform: "claude" }, codex: { bin: "/opt/codex" } });
  });

  test("with an endpoint as well, model calls go to the connection and agent work to the harness", async () => {
    const server = endpoint("https://api.example.test/v1", MODELS);

    const summary = await server.serve(() => run({ endpoint: "https://api.example.test/v1", harness: "claude" }));

    expect(summary.runs.modelCalls).toContain('connection "default"');
    expect(summary.runs.agentWork).toContain('harness "claude"');
  });
});

describe("akm setup --embedding", () => {
  const withConnection = (extra: RawEngineFlags) => run({ endpoint: "http://localhost:11434/v1", ...extra });

  test("a model on the connection is the bare model", async () => {
    await endpoint("http://localhost:11434/v1", MODELS).serve(() =>
      withConnection({ embedding: "text-embedding-3-small" }),
    );
    expect(written().embedding).toEqual({ model: "text-embedding-3-small" });
    expect(written().semanticSearchMode).toBe("auto");
  });

  test("local is the built-in embedder: semantic search on, no embedding block", async () => {
    await endpoint("http://localhost:11434/v1", MODELS).serve(() => withConnection({ embedding: "local" }));
    expect("embedding" in written()).toBe(false);
    expect(written().semanticSearchMode).toBe("auto");
  });

  test("off turns semantic search off", async () => {
    await endpoint("http://localhost:11434/v1", MODELS).serve(() => withConnection({ embedding: "off" }));
    expect(written().semanticSearchMode).toBe("off");
  });

  test("another endpoint carries its own URL and key variable", async () => {
    await run({
      embedding: "e5-large",
      embeddingEndpoint: "https://emb.example.test",
      embeddingApiKeyEnv: "EMB_KEY",
    });
    expect(written().embedding).toEqual({
      endpoint: "https://emb.example.test/v1",
      model: "e5-large",
      apiKey: "$EMB_KEY",
    });
  });

  test("a model on the connection with no connection to serve it stops before writing anything", async () => {
    await expect(run({ embedding: "nomic-embed-text" })).rejects.toThrow(/served by the default connection/);
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});

describe("akm setup --from <file> --yes with engine flags", () => {
  test("the file is merged, then the flags and defaults fill what it leaves", async () => {
    const server = endpoint("http://localhost:11434/v1", MODELS);

    const summary: SetupSummary = await server.serve(() =>
      runSetupFromConfig({
        configJson: JSON.stringify({ output: { format: "text" } }),
        noInit: true,
        applyDefaults: true,
        flags: flags({ endpoint: "http://localhost:11434/v1", embedding: "off" }),
      }),
    );

    expect(written().output).toEqual({ format: "text", detail: "brief" });
    expect((written().connections as Record<string, unknown>).default).toBeDefined();
    expect(summary.fields).toEqual(["output"]);
  });
});
