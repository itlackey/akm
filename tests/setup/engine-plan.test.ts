// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the setup answers change in the config: connections, harnesses,
 * embedding, and the keys bound for credentials.json. Pure, so no prompt, no
 * network and no file is involved.
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { applyEngineAnswers, harnessEntries } from "../../src/setup/engine-plan";

const cfg = (partial: Partial<AkmConfig> = {}): AkmConfig => ({ semanticSearchMode: "off", ...partial });

const picks = { fast: "small", balanced: "mid", reasoning: "big" };

describe("a connection answer", () => {
  test("a new connection gets the endpoint and one model per alias, and no key", () => {
    const { patch, credentials } = applyEngineAnswers(cfg(), {
      connection: { name: "default", endpoint: "http://localhost:11434/v1", picks },
    });
    expect(patch.connections).toEqual({ default: { endpoint: "http://localhost:11434/v1", models: picks } });
    expect(credentials).toEqual({});
  });

  test("a key named by a variable is written as a $VAR reference", () => {
    const { patch, credentials } = applyEngineAnswers(cfg(), {
      connection: { name: "default", endpoint: "https://api.example.test/v1", key: { env: "EXAMPLE_KEY" }, picks },
    });
    expect(patch.connections?.default?.apiKey).toBe("$EXAMPLE_KEY");
    expect(credentials).toEqual({});
  });

  test("a pasted key goes to credentials.json under the connection's name and never into the config", () => {
    const { patch, credentials } = applyEngineAnswers(cfg(), {
      connection: { name: "lab", endpoint: "https://api.example.test/v1", key: { pasted: "sk-typed-secret" }, picks },
    });
    expect(credentials).toEqual({ lab: "sk-typed-secret" });
    expect(JSON.stringify(patch)).not.toContain("sk-typed-secret");
    expect(patch.connections?.lab).not.toHaveProperty("apiKey");
  });

  test("a pasted key replaces the $VAR the connection had", () => {
    const current = cfg({ connections: { default: { endpoint: "https://e/v1", apiKey: "$OLD_KEY", models: picks } } });
    const { patch, credentials } = applyEngineAnswers(current, {
      connection: { name: "default", endpoint: "https://e/v1", key: { pasted: "typed" }, picks },
    });
    expect(patch.connections?.default).not.toHaveProperty("apiKey");
    expect(credentials).toEqual({ default: "typed" });
  });

  test("no key answer keeps the key the connection has, and everything else it holds", () => {
    const current = cfg({
      connections: {
        default: {
          endpoint: "https://old/v1",
          apiKey: "$KEPT",
          timeoutMs: 900000,
          top_p: 0.9,
          models: { fast: "old-small", coder: "qwen3-coder" },
        },
        other: { endpoint: "https://other/v1" },
      },
    });
    const { patch } = applyEngineAnswers(current, {
      connection: { name: "default", endpoint: "https://new/v1", picks },
    });
    expect(patch.connections?.default).toEqual({
      endpoint: "https://new/v1",
      apiKey: "$KEPT",
      models: { fast: "small", coder: "qwen3-coder", balanced: "mid", reasoning: "big" },
      timeoutMs: 900000,
      top_p: 0.9,
    });
    expect(patch.connections?.other).toEqual({ endpoint: "https://other/v1" });
  });

  test("a pick for an alias whose entry carries request fields changes the model and keeps the fields", () => {
    const current = cfg({
      connections: {
        default: {
          endpoint: "https://e/v1",
          models: { reasoning: { model: "glm-5", reasoning_effort: "high" } },
        },
      },
    });
    const { patch } = applyEngineAnswers(current, {
      connection: { name: "default", endpoint: "https://e/v1", picks: { reasoning: "glm-5.1" } },
    });
    expect(patch.connections?.default?.models?.reasoning).toEqual({ model: "glm-5.1", reasoning_effort: "high" });
  });

  test("an answer with no picks (an endpoint that listed nothing) leaves the connection without models", () => {
    const { patch } = applyEngineAnswers(cfg(), {
      connection: { name: "default", endpoint: "https://e/v1", picks: {} },
    });
    expect(patch.connections?.default).toEqual({ endpoint: "https://e/v1" });
  });
});

describe("harnessEntries", () => {
  test("a lone harness keeps its platform name", () => {
    expect(harnessEntries(undefined, ["claude"], "claude")).toEqual({ claude: {} });
  });

  test("with several, the default is the entry named default, first", () => {
    const entries = harnessEntries(undefined, ["claude", "codex", "opencode"], "codex");
    expect(Object.keys(entries)).toEqual(["default", "claude", "opencode"]);
    expect(entries.default).toEqual({ platform: "codex" });
    expect(entries.claude).toEqual({});
  });

  test("an entry that stays enabled keeps what it holds, including its own name", () => {
    const existing = { "claude-work": { platform: "claude", bin: "/opt/claude-work/bin/claude" } } as never;
    const entries = harnessEntries(existing, ["claude", "codex"], "codex");
    expect(entries["claude-work"]).toEqual({ platform: "claude", bin: "/opt/claude-work/bin/claude" });
    expect(Object.keys(entries).sort()).toEqual(["claude-work", "default"]);
    expect(entries.default).toEqual({ platform: "codex" });
  });

  test("a platform that is no longer selected is removed", () => {
    expect(harnessEntries({ claude: {}, codex: {} }, ["claude"], "claude")).toEqual({ claude: {} });
  });

  test("moving the default displaces the entry that was named default back to its platform name", () => {
    const existing = { default: { platform: "claude", args: ["--x"] }, codex: {} } as never;
    const entries = harnessEntries(existing, ["claude", "codex"], "codex");
    expect(entries.default).toEqual({ platform: "codex" });
    expect(entries.claude).toEqual({ args: ["--x"] });
  });

  test("keeping the same default changes nothing", () => {
    const existing = { default: { platform: "claude" }, codex: {} } as never;
    expect(harnessEntries(existing, ["claude", "codex"], "claude")).toEqual(existing);
  });

  test("a new platform whose name an entry of another platform has takes a free name", () => {
    const existing = { claude: { platform: "codex" } } as never;
    const entries = harnessEntries(existing, ["codex", "claude"], "codex");
    expect(entries).toEqual({ default: { platform: "codex" }, "claude-2": { platform: "claude" } });
  });

  test("no platform selected leaves no harnesses, and the patch removes the key", () => {
    expect(harnessEntries({ claude: {} }, [], undefined)).toEqual({});
    const { patch } = applyEngineAnswers(cfg({ harnesses: { claude: {} } }), { harnesses: { platforms: [] } });
    expect("harnesses" in patch).toBe(true);
    expect(patch.harnesses).toBeUndefined();
  });
});

describe("an embedding answer", () => {
  const withModel = cfg({ embedding: { model: "nomic-embed-text" } });

  test("a model on the connection is the bare model, with no endpoint of its own", () => {
    const { patch } = applyEngineAnswers(cfg(), { embedding: { kind: "connection", model: "nomic-embed-text" } });
    expect(patch.embedding).toEqual({ model: "nomic-embed-text" });
  });

  test("choosing what is already configured keeps the block as it is", () => {
    const current = cfg({ embedding: { model: "nomic-embed-text", dimension: 768 } });
    const { patch } = applyEngineAnswers(current, { embedding: { kind: "connection", model: "nomic-embed-text" } });
    expect(patch.embedding).toBe(current.embedding);
  });

  test("the built-in embedder removes the block; off leaves it for a later return", () => {
    expect(applyEngineAnswers(withModel, { embedding: { kind: "local" } }).patch.embedding).toBeUndefined();
    expect("embedding" in applyEngineAnswers(withModel, { embedding: { kind: "local" } }).patch).toBe(true);
    expect(applyEngineAnswers(withModel, { embedding: { kind: "off" } }).patch.embedding).toBe(withModel.embedding);
  });

  test("another endpoint carries its own URL, model and key reference", () => {
    const { patch, credentials } = applyEngineAnswers(cfg(), {
      embedding: { kind: "endpoint", endpoint: "https://emb.example.test/v1", model: "e5", key: { env: "EMB_KEY" } },
    });
    expect(patch.embedding).toEqual({ endpoint: "https://emb.example.test/v1", model: "e5", apiKey: "$EMB_KEY" });
    expect(credentials).toEqual({});
  });

  test("another endpoint's pasted key goes to credentials.json under embedding", () => {
    const { patch, credentials } = applyEngineAnswers(cfg(), {
      embedding: { kind: "endpoint", endpoint: "https://emb.example.test/v1", model: "e5", key: { pasted: "typed" } },
    });
    expect(credentials).toEqual({ embedding: "typed" });
    expect(patch.embedding).toEqual({ endpoint: "https://emb.example.test/v1", model: "e5" });
  });

  test("the same endpoint and model keep the tuning the block has, and its key when none is given", () => {
    const current = cfg({
      embedding: { endpoint: "https://emb.example.test/v1", model: "e5", apiKey: "$EMB_KEY", dimension: 1024 },
    });
    const { patch } = applyEngineAnswers(current, {
      embedding: { kind: "endpoint", endpoint: "https://emb.example.test/v1", model: "e5" },
    });
    expect(patch.embedding).toEqual({
      endpoint: "https://emb.example.test/v1",
      model: "e5",
      dimension: 1024,
      apiKey: "$EMB_KEY",
    });
  });
});

test("answers that name nothing change nothing", () => {
  expect(applyEngineAnswers(cfg(), {})).toEqual({ patch: {}, credentials: {} });
});
