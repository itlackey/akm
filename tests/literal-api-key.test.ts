// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A key left in `config.json` as a literal belongs to the user: an ordinary
 * write does not delete it, and akm never reads, sends or prints it.
 * `akm migrate apply` is what moves it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigValue, listConfig, setConfigValue } from "../src/commands/config-cli";
import { loadUserConfig, mutateConfig, resetConfigCache } from "../src/core/config/config";
import { collectCredentialValues, deleteCredential, writeCredential } from "../src/core/config/credentials";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { buildExecution, resolveExecution } from "../src/integrations/agent/execution";
import { runExecution } from "../src/integrations/agent/runner-dispatch";
import type { ChatCompletionConfig } from "../src/llm/client";
import { embed } from "../src/llm/embedder";
import { effectiveEmbedding } from "../src/llm/embedders/connection";

const LITERAL = "sk-literal-left-in-the-file";

function writeConfig(value: unknown): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(value));
  resetConfigCache();
}

const withLiteral = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  connections: { lab: { endpoint: "http://lab:1/v1", models: { fast: "m" }, apiKey: LITERAL } },
  embedding: { model: "embed-model", apiKey: LITERAL },
};

beforeEach(() => {
  _resetWarnOnceForTests();
  _setWarnSinkForTests(() => {});
});
afterEach(() => {
  _setWarnSinkForTests(undefined);
  deleteCredential("lab");
  resetConfigCache();
});

describe("a literal apiKey in the file", () => {
  test("survives an unrelated write", () => {
    writeConfig(withLiteral);
    mutateConfig((current) => ({ ...current, output: { format: "text" } }));
    const after = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(after.connections.lab.apiKey).toBe(LITERAL);
    expect(after.embedding.apiKey).toBe(LITERAL);
    expect(after.output).toEqual({ format: "text" });
  });

  test("is kept in the loaded config, but the runner never carries it", () => {
    writeConfig(withLiteral);
    const config = loadUserConfig();
    expect(config.connections?.lab?.apiKey).toBe(LITERAL);
    const { runner } = resolveExecution({ content: "x", config, modelWork: true });
    expect(runner).not.toHaveProperty("apiKey");
    expect(JSON.stringify(runner)).not.toContain(LITERAL);
  });

  test("is never sent on a chat call: no key, or the one stored under the connection's name", async () => {
    writeConfig(withLiteral);
    const prepared = resolveExecution({ content: "x", config: loadUserConfig(), modelWork: true });
    const built = buildExecution(prepared.request, prepared.runner);
    const sent: Array<string | undefined> = [];
    const chat = async (connection: ChatCompletionConfig) => {
      sent.push(connection.apiKey);
      return "ok";
    };

    await runExecution(built, { chat });
    writeCredential("lab", "from-the-store");
    await runExecution(built, { chat });

    expect(sent).toEqual([undefined, "from-the-store"]);
  });

  test("is never sent on an embedding request", async () => {
    writeConfig(withLiteral);
    let auth = "unset";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        auth = request.headers.get("authorization") ?? "";
        await request.json();
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const config = loadUserConfig();
      const wired = {
        ...config,
        connections: { lab: { ...config.connections?.lab, endpoint: `http://localhost:${server.port}/v1` } },
      } as typeof config;
      // The embedding runs on the default connection, whose literal is not a reference either.
      await embed("hello", effectiveEmbedding(wired));
      expect(auth).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("is never printed by config get, for the key itself or for the entry that holds it", () => {
    writeConfig({
      ...withLiteral,
      search: { curateRerank: { endpoint: "http://rerank:1/v1/rerank", model: "r", apiKey: LITERAL } },
    });
    const held = loadUserConfig();
    for (const key of ["connections.lab.apiKey", "embedding.apiKey", "search.curateRerank.apiKey"]) {
      expect(getConfigValue(held, key), key).toBeUndefined();
    }
    for (const key of ["connections.lab", "embedding", "search.curateRerank"]) {
      expect(JSON.stringify(getConfigValue(held, key)), key).not.toContain(LITERAL);
    }
    expect(JSON.stringify(listConfig(held))).not.toContain(LITERAL);
    // A reference is not a secret and prints as written.
    expect(getConfigValue(setConfigValue(held, "connections.lab.apiKey", "$LAB_KEY"), "connections.lab.apiKey")).toBe(
      "$LAB_KEY",
    );
  });

  test("is redacted from output, as a key the config holds", () => {
    writeConfig(withLiteral);
    expect(collectCredentialValues(loadUserConfig(), {})).toContain(LITERAL);
  });
});
