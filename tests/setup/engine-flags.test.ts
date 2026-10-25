// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../src/core/errors";
import { hasEngineFlags, parseEngineFlags } from "../../src/setup/engine-flags";

describe("parseEngineFlags", () => {
  test("no flag answers no question", () => {
    expect(parseEngineFlags({})).toEqual({});
    expect(hasEngineFlags(parseEngineFlags({}))).toBe(false);
  });

  test("endpoints are stored as base URLs and the key is named by its variable", () => {
    const flags = parseEngineFlags({
      endpoint: "http://localhost:11434",
      apiKeyEnv: "LAB_KEY",
      name: "lab",
      embedding: "nomic-embed-text",
      embeddingEndpoint: "https://emb.example.test",
      embeddingApiKeyEnv: "EMB_KEY",
    });
    expect(flags).toEqual({
      endpoint: "http://localhost:11434/v1",
      apiKeyEnv: "LAB_KEY",
      name: "lab",
      embedding: "nomic-embed-text",
      embeddingEndpoint: "https://emb.example.test/v1",
      embeddingApiKeyEnv: "EMB_KEY",
    });
    expect(hasEngineFlags(flags)).toBe(true);
  });

  test("--harness is a comma-separated list of platforms, first is the default", () => {
    expect(parseEngineFlags({ harness: "claude, opencode" }).harness).toEqual(["claude", "opencode"]);
  });

  test("an unknown platform names the valid ones", () => {
    expect(() => parseEngineFlags({ harness: "claude,cursor" })).toThrow(/unknown platform cursor.*claude/);
  });

  test("a key value in place of a variable name is refused, and never echoed", () => {
    let message = "";
    try {
      parseEngineFlags({ apiKeyEnv: "sk-live-abc123!" });
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      message = (err as Error).message;
    }
    expect(message).toContain("--api-key-env");
    expect(message).not.toContain("sk-live-abc123");
  });

  test("a bad endpoint, name or embedding combination is a usage error", () => {
    expect(() => parseEngineFlags({ endpoint: "nope" })).toThrow(/--endpoint/);
    expect(() => parseEngineFlags({ name: "Bad Name" })).toThrow(/--name/);
    expect(() => parseEngineFlags({ embeddingEndpoint: "https://e.test/v1" })).toThrow(/needs --embedding <model>/);
    expect(() => parseEngineFlags({ embedding: "local", embeddingEndpoint: "https://e.test/v1" })).toThrow(
      /needs --embedding <model>/,
    );
    expect(() => parseEngineFlags({ embeddingApiKeyEnv: "EMB_KEY" })).toThrow(/needs --embedding-endpoint/);
  });
});
