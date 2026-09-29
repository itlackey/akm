// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedding profiles: query and document templates matched on the model
 * name, config overrides, template application, and the document template's
 * place in the embedding fingerprint.
 */

import { describe, expect, test } from "bun:test";
import { deriveSemanticProviderFingerprint } from "../src/indexer/materialize-embeddings";
import {
  applyEmbeddingTemplate,
  documentTemplateFingerprint,
  resolveEmbeddingProfile,
} from "../src/llm/embedders/profile";

const remote = (model: string, extra: Record<string, unknown> = {}) => ({
  endpoint: "https://embed.example/v1/embeddings",
  model,
  ...extra,
});

const QWEN3_QUERY = "Instruct: Given a question or task, retrieve the knowledge asset that helps with it\nQuery:{text}";
const RETRIEVAL_QUERY = "Represent this sentence for searching relevant passages: {text}";

describe("resolveEmbeddingProfile presets", () => {
  test.each([
    ["embed/qwen3-embedding-0.6b", { queryTemplate: QWEN3_QUERY }],
    ["Qwen/Qwen3-Embedding-8B", { queryTemplate: QWEN3_QUERY }],
    ["nomic-embed-text:v1.5", { queryTemplate: "search_query: {text}", documentTemplate: "search_document: {text}" }],
    ["BAAI/bge-base-en-v1.5", { queryTemplate: RETRIEVAL_QUERY }],
    ["mxbai-embed-large", { queryTemplate: RETRIEVAL_QUERY }],
    ["Snowflake/snowflake-arctic-embed-m", { queryTemplate: RETRIEVAL_QUERY }],
    ["intfloat/e5-large-v2", { queryTemplate: "query: {text}", documentTemplate: "passage: {text}" }],
    ["intfloat/multilingual-e5-small", { queryTemplate: "query: {text}", documentTemplate: "passage: {text}" }],
    ["BAAI/bge-m3", {}],
    ["intfloat/multilingual-e5-large-instruct", {}],
    ["text-embedding-3-small", {}],
  ])("%s", (model, profile) => {
    expect(resolveEmbeddingProfile(remote(model))).toEqual(profile);
  });

  test("a local model matches on localModel, defaulting to bge-small-en-v1.5", () => {
    expect(resolveEmbeddingProfile(undefined)).toEqual({ queryTemplate: RETRIEVAL_QUERY });
    expect(resolveEmbeddingProfile({ localModel: "nomic-ai/nomic-embed-text-v1.5" }).documentTemplate).toBe(
      "search_document: {text}",
    );
  });
});

describe("resolveEmbeddingProfile overrides", () => {
  test("a configured template replaces the preset for its side only", () => {
    expect(resolveEmbeddingProfile(remote("nomic-embed-text", { queryTemplate: "find: {text}" }))).toEqual({
      queryTemplate: "find: {text}",
      documentTemplate: "search_document: {text}",
    });
  });

  test("an empty template turns the preset off", () => {
    expect(resolveEmbeddingProfile(remote("qwen3-embedding-0.6b", { queryTemplate: "" }))).toEqual({});
    expect(resolveEmbeddingProfile(remote("e5-base-v2", { documentTemplate: "" }))).toEqual({
      queryTemplate: "query: {text}",
    });
  });

  test("a model with no preset takes the configured templates", () => {
    expect(resolveEmbeddingProfile(remote("house-model", { documentTemplate: "doc: {text}" }))).toEqual({
      documentTemplate: "doc: {text}",
    });
  });
});

describe("applyEmbeddingTemplate", () => {
  test("puts the text where {text} is, keeping its case", () => {
    expect(applyEmbeddingTemplate(QWEN3_QUERY, "Docker HealthCheck")).toBe(
      "Instruct: Given a question or task, retrieve the knowledge asset that helps with it\nQuery:Docker HealthCheck",
    );
  });

  test("treats a template without {text} as a prefix, and no template as none", () => {
    expect(applyEmbeddingTemplate("search_query: ", "Kafka")).toBe("search_query: Kafka");
    expect(applyEmbeddingTemplate(undefined, "Kafka")).toBe("Kafka");
  });

  test("inserts replacement-pattern characters in the text literally", () => {
    expect(applyEmbeddingTemplate("query: {text}", "cost $& and $1")).toBe("query: cost $& and $1");
  });
});

describe("embedding fingerprint", () => {
  test("is unchanged for a model whose profile has no document template", () => {
    expect(documentTemplateFingerprint(remote("embed/qwen3-embedding-0.6b"))).toBe("");
    expect(deriveSemanticProviderFingerprint(remote("embed/qwen3-embedding-0.6b", { dimension: 1024 }))).toBe(
      "remote:embed/qwen3-embedding-0.6b|1024",
    );
    expect(deriveSemanticProviderFingerprint(undefined)).toBe("local:Xenova/bge-small-en-v1.5");
  });

  test("changes with the document template", () => {
    const preset = deriveSemanticProviderFingerprint(remote("nomic-embed-text"));
    const custom = deriveSemanticProviderFingerprint(remote("nomic-embed-text", { documentTemplate: "doc: {text}" }));
    const none = deriveSemanticProviderFingerprint(remote("nomic-embed-text", { documentTemplate: "" }));
    expect(preset).toStartWith("remote:nomic-embed-text|default|doc:");
    expect(custom).toStartWith("remote:nomic-embed-text|default|doc:");
    expect(custom).not.toBe(preset);
    expect(none).toBe("remote:nomic-embed-text|default");
  });

  test("ignores the query template", () => {
    expect(deriveSemanticProviderFingerprint(remote("house-model", { queryTemplate: "q: {text}" }))).toBe(
      deriveSemanticProviderFingerprint(remote("house-model")),
    );
  });
});
