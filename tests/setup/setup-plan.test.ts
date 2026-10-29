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
import { applySetupAnswers, harnessEntries } from "../../src/setup/setup-plan";

const cfg = (partial: Partial<AkmConfig> = {}): AkmConfig => ({ semanticSearchMode: "off", ...partial });

const picks = { fast: "small", balanced: "mid", reasoning: "big" };

describe("a connection answer", () => {
  test("a new connection gets the endpoint and one model per alias, and no key", () => {
    const { patch, credentials } = applySetupAnswers(cfg(), {
      connection: { name: "default", endpoint: "http://localhost:11434/v1", picks },
    });
    expect(patch.connections).toEqual({ default: { endpoint: "http://localhost:11434/v1", models: picks } });
    expect(credentials).toEqual([]);
  });

  test("a key named by a variable is written as a $VAR reference", () => {
    const { patch, credentials } = applySetupAnswers(cfg(), {
      connection: { name: "default", endpoint: "https://api.example.test/v1", key: { env: "EXAMPLE_KEY" }, picks },
    });
    expect(patch.connections?.default?.apiKey).toBe("$EXAMPLE_KEY");
    expect(credentials).toEqual([]);
  });

  test("a pasted key goes to credentials.json for the connection and its endpoint, and never into the config", () => {
    const { patch, credentials } = applySetupAnswers(cfg(), {
      connection: { name: "lab", endpoint: "https://api.example.test/v1", key: { pasted: "sk-typed-secret" }, picks },
    });
    expect(credentials).toEqual([
      { slot: { connection: "lab" }, key: "sk-typed-secret", endpoint: "https://api.example.test/v1" },
    ]);
    expect(JSON.stringify(patch)).not.toContain("sk-typed-secret");
    expect(patch.connections?.lab).not.toHaveProperty("apiKey");
  });

  test("a pasted key replaces the $VAR the connection had", () => {
    const current = cfg({ connections: { default: { endpoint: "https://e/v1", apiKey: "$OLD_KEY", models: picks } } });
    const { patch, credentials } = applySetupAnswers(current, {
      connection: { name: "default", endpoint: "https://e/v1", key: { pasted: "typed" }, picks },
    });
    expect(patch.connections?.default).not.toHaveProperty("apiKey");
    expect(credentials).toEqual([{ slot: { connection: "default" }, key: "typed", endpoint: "https://e/v1" }]);
  });

  test("no key answer keeps the key the connection has for the same endpoint, and everything else it holds", () => {
    const current = cfg({
      connections: {
        default: {
          endpoint: "https://new/v1/chat/completions",
          apiKey: "$KEPT",
          timeoutMs: 900000,
          top_p: 0.9,
          models: { fast: "old-small", coder: "qwen3-coder" },
        },
        other: { endpoint: "https://other/v1" },
      },
    });
    const { patch } = applySetupAnswers(current, {
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

  test("a key belongs to its endpoint: with no key answer, a connection moved to another server starts without the $VAR it had", () => {
    const current = cfg({
      connections: { default: { endpoint: "https://a.example.test/v1", apiKey: "$A_KEY", models: picks } },
    });
    const { patch, credentials } = applySetupAnswers(current, {
      connection: { name: "default", endpoint: "https://b.example.test/v1", picks },
    });
    expect(patch.connections?.default).toEqual({ endpoint: "https://b.example.test/v1", models: picks });
    expect(credentials).toEqual([]);
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
    const { patch } = applySetupAnswers(current, {
      connection: { name: "default", endpoint: "https://e/v1", picks: { reasoning: "glm-5.1" } },
    });
    expect(patch.connections?.default?.models?.reasoning).toEqual({ model: "glm-5.1", reasoning_effort: "high" });
  });

  test("an answer with no picks (an endpoint that listed nothing) leaves the connection without models", () => {
    const { patch } = applySetupAnswers(cfg(), {
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
    const { patch } = applySetupAnswers(cfg({ harnesses: { claude: {} } }), { harnesses: { platforms: [] } });
    expect("harnesses" in patch).toBe(true);
    expect(patch.harnesses).toBeUndefined();
  });
});

describe("the answer about model calls on the default harness", () => {
  test("no is saved on the default harness's entry and nowhere else, and yes clears it", () => {
    const current = cfg({ harnesses: { default: { platform: "gemini" }, claude: {} } });
    const off = applySetupAnswers(current, { harnessModelWork: false }).patch.harnesses;
    expect(off).toEqual({ default: { platform: "gemini", modelWork: false }, claude: {} });

    const on = applySetupAnswers(cfg({ harnesses: off }), { harnessModelWork: true }).patch.harnesses;
    expect(on).toEqual({ default: { platform: "gemini" }, claude: {} });
  });

  test("applies to a lone harness whatever it is called, and to the harnesses the same answer sets", () => {
    expect(applySetupAnswers(cfg({ harnesses: { gemini: {} } }), { harnessModelWork: false }).patch.harnesses).toEqual({
      gemini: { modelWork: false },
    });
    expect(
      applySetupAnswers(cfg(), {
        harnesses: { platforms: ["gemini"], default: "gemini" },
        harnessModelWork: false,
      }).patch.harnesses,
    ).toEqual({ gemini: { modelWork: false } });
  });

  test("changes nothing when the entry already says it, or there is no harness", () => {
    expect(applySetupAnswers(cfg({ harnesses: { gemini: {} } }), { harnessModelWork: true }).patch).toEqual({});
    expect(
      applySetupAnswers(cfg({ harnesses: { gemini: { modelWork: false } } }), { harnessModelWork: false }).patch,
    ).toEqual({});
    expect(applySetupAnswers(cfg(), { harnessModelWork: false }).patch).toEqual({});
    // Several and none called default: there is no default harness to mark.
    expect(
      applySetupAnswers(cfg({ harnesses: { gemini: {}, claude: {} } }), { harnessModelWork: false }).patch,
    ).toEqual({});
  });
});

describe("an embedding answer", () => {
  const withModel = cfg({ embedding: { model: "nomic-embed-text" } });

  test("a model on the connection is the bare model, with no endpoint of its own", () => {
    const { patch } = applySetupAnswers(cfg(), { embedding: { kind: "connection", model: "nomic-embed-text" } });
    expect(patch.embedding).toEqual({ model: "nomic-embed-text" });
  });

  test("choosing what is already configured keeps the block as it is", () => {
    const current = cfg({ embedding: { model: "nomic-embed-text", dimension: 768 } });
    const { patch } = applySetupAnswers(current, { embedding: { kind: "connection", model: "nomic-embed-text" } });
    expect(patch.embedding).toBe(current.embedding);
  });

  test("the built-in embedder removes the block; off leaves it for a later return", () => {
    expect(applySetupAnswers(withModel, { embedding: { kind: "local" } }).patch.embedding).toBeUndefined();
    expect("embedding" in applySetupAnswers(withModel, { embedding: { kind: "local" } }).patch).toBe(true);
    expect(applySetupAnswers(withModel, { embedding: { kind: "off" } }).patch.embedding).toBe(withModel.embedding);
  });

  test("another endpoint carries its own URL, model and key reference", () => {
    const { patch, credentials } = applySetupAnswers(cfg(), {
      embedding: { kind: "endpoint", endpoint: "https://emb.example.test/v1", model: "e5", key: { env: "EMB_KEY" } },
    });
    expect(patch.embedding).toEqual({ endpoint: "https://emb.example.test/v1", model: "e5", apiKey: "$EMB_KEY" });
    expect(credentials).toEqual([]);
  });

  test("another endpoint's pasted key goes to credentials.json for the embedding service and its endpoint", () => {
    const { patch, credentials } = applySetupAnswers(cfg(), {
      embedding: { kind: "endpoint", endpoint: "https://emb.example.test/v1", model: "e5", key: { pasted: "typed" } },
    });
    expect(credentials).toEqual([
      { slot: { service: "embedding" }, key: "typed", endpoint: "https://emb.example.test/v1" },
    ]);
    expect(patch.embedding).toEqual({ endpoint: "https://emb.example.test/v1", model: "e5" });
  });

  test("the same endpoint and model keep the tuning the block has, and its key when none is given", () => {
    const current = cfg({
      embedding: { endpoint: "https://emb.example.test/v1", model: "e5", apiKey: "$EMB_KEY", dimension: 1024 },
    });
    const { patch } = applySetupAnswers(current, {
      embedding: { kind: "endpoint", endpoint: "https://emb.example.test/v1", model: "e5" },
    });
    expect(patch.embedding).toEqual({
      endpoint: "https://emb.example.test/v1",
      model: "e5",
      dimension: 1024,
      apiKey: "$EMB_KEY",
    });
  });

  test("a key belongs to its endpoint: another endpoint starts without the $VAR the block had, and the same one keeps it for another model", () => {
    const current = cfg({
      embedding: { endpoint: "https://emb.example.test/v1", model: "e5", apiKey: "$EMB_KEY" },
    });
    const moved = applySetupAnswers(current, {
      embedding: { kind: "endpoint", endpoint: "https://other.example.test/v1", model: "e5" },
    });
    expect(moved.patch.embedding).toEqual({ endpoint: "https://other.example.test/v1", model: "e5" });
    const remodelled = applySetupAnswers(current, {
      embedding: { kind: "endpoint", endpoint: "https://emb.example.test/v1", model: "bge" },
    });
    expect(remodelled.patch.embedding).toEqual({
      endpoint: "https://emb.example.test/v1",
      model: "bge",
      apiKey: "$EMB_KEY",
    });
  });
});

test("answers that name nothing change nothing", () => {
  expect(applySetupAnswers(cfg(), {})).toEqual({ patch: {}, credentials: [] });
});
