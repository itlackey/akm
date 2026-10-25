// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `embedding.model` without an `embedding.endpoint` is served by the default
 * connection: its endpoint and its key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config/config";
import { deleteCredential, writeCredential } from "../src/core/config/credentials";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { _setEmbedderForTests, embed, resolveEmbeddingModelId } from "../src/llm/embedder";
import { effectiveEmbedding } from "../src/llm/embedders/connection";
import { hasRemoteEndpoint } from "../src/llm/embedders/remote";
import { prepareSemanticSearchAssets } from "../src/setup/semantic-assets";
import { withEnv } from "./_helpers/sandbox";

const LAB = { endpoint: "http://lab:8080/v1/chat/completions", models: { fast: "qwen3-8b" } };

const configOf = (extra: Record<string, unknown>): AkmConfig =>
  ({ configVersion: "0.9.0", semanticSearchMode: "off", ...extra }) as AkmConfig;

let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  deleteCredential("default");
});

describe("effectiveEmbedding", () => {
  test("an embedding with its own endpoint, or none at all, is left as written", () => {
    const own = { endpoint: "http://embed:1/v1", model: "m" };
    const config = configOf({ embedding: own, connections: { default: LAB } });
    expect(effectiveEmbedding(config)).toBe(own);
    expect(effectiveEmbedding(configOf({ connections: { default: LAB } }))).toBeUndefined();
    // No model: the built-in local embedder, whatever connections exist.
    const local = { localModel: "Xenova/some-model" };
    expect(effectiveEmbedding(configOf({ embedding: local, connections: { default: LAB } }))).toBe(local);
  });

  test("a model with no endpoint takes the default connection's endpoint and $VAR key, keeping the rest", () => {
    const config = configOf({
      embedding: { model: "nomic-embed-text", dimension: 768 },
      connections: { default: { ...LAB, apiKey: "$LAB_KEY" } },
    });
    expect(effectiveEmbedding(config)).toEqual({
      model: "nomic-embed-text",
      dimension: 768,
      endpoint: "http://lab:8080/v1",
      apiKey: "$LAB_KEY",
      credentialName: "default",
    });
    // Read, never stored: the config itself is untouched.
    expect(config.embedding).toEqual({ model: "nomic-embed-text", dimension: 768 });
  });

  test("the default connection is the one named default, else the lone one", () => {
    const embedding = { model: "m" };
    const lone = configOf({ embedding, connections: { only: LAB } });
    expect(effectiveEmbedding(lone)).toMatchObject({ endpoint: "http://lab:8080/v1", credentialName: "only" });
    const two = configOf({
      embedding,
      connections: { first: LAB, default: { ...LAB, endpoint: "http://other:1/v1" } },
    });
    expect(effectiveEmbedding(two)).toMatchObject({ endpoint: "http://other:1/v1", credentialName: "default" });
  });

  test("with no default connection it warns once and the built-in local embedder runs", () => {
    const config = configOf({ embedding: { model: "nomic-embed-text" }, connections: { a: LAB, b: LAB } });
    const first = effectiveEmbedding(config);
    effectiveEmbedding(config);
    expect(first && hasRemoteEndpoint(first)).toBe(false);
    expect(warnings.filter((warning) => warning.includes("no default connection"))).toHaveLength(1);
    expect(effectiveEmbedding(configOf({ embedding: { model: "m" } }))).toMatchObject({ model: "m" });
  });

  test("the model id the index records is the embedding model", () => {
    const config = configOf({ embedding: { model: "nomic-embed-text" }, connections: { default: LAB } });
    expect(resolveEmbeddingModelId(effectiveEmbedding(config))).toBe("nomic-embed-text");
  });
});

describe("an embedding on the default connection sends that connection's key", () => {
  async function authSeenBy(config: AkmConfig): Promise<string> {
    let auth = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        auth = request.headers.get("authorization") ?? "";
        await request.json();
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], model: "m" }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const wired = {
        ...config,
        connections: Object.fromEntries(
          Object.entries(config.connections ?? {}).map(([name, connection]) => [
            name,
            { ...connection, endpoint: `http://localhost:${server.port}/v1` },
          ]),
        ),
      };
      await embed("hello", effectiveEmbedding(wired as AkmConfig));
      return auth;
    } finally {
      server.stop(true);
    }
  }

  test("the connection's $VAR key", async () => {
    const config = configOf({
      embedding: { model: "m" },
      connections: { default: { ...LAB, apiKey: "$CONNECTION_EMBED_KEY" } },
    });
    expect(await withEnv({ CONNECTION_EMBED_KEY: "from-env" }, () => authSeenBy(config))).toBe("Bearer from-env");
  });

  test("the key stored under the connection's name", async () => {
    writeCredential("default", "from-store");
    const config = configOf({ embedding: { model: "m" }, connections: { default: LAB } });
    expect(await authSeenBy(config)).toBe("Bearer from-store");
  });

  test("no key anywhere sends none", async () => {
    expect(await authSeenBy(configOf({ embedding: { model: "m" }, connections: { default: LAB } }))).toBe("");
  });
});

describe("setup's semantic-search preparation", () => {
  test("checks the endpoint of the connection that serves the embedding model, not the local model", async () => {
    let checked: unknown;
    _setEmbedderForTests({
      isTransformersAvailable: () => false,
      checkEmbeddingAvailability: async (embedding) => {
        checked = embedding;
        return { available: true };
      },
    });
    try {
      const ready = await prepareSemanticSearchAssets(
        configOf({ connections: { default: LAB }, embedding: { model: "nomic-embed-text" } }),
      );
      expect(ready).toEqual({ ok: true });
    } finally {
      _setEmbedderForTests(undefined);
    }
    expect(checked).toMatchObject({ endpoint: "http://lab:8080/v1", model: "nomic-embed-text" });
  });
});
