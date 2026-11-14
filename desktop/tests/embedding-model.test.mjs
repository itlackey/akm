// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  embeddingChange,
  embeddingChanges,
  embeddingDraft,
  embeddingErrors,
  embeddingSource,
  keyStatus,
  reembeds,
} from "../src/lib/embedding-model.ts";

const remote = {
  endpoint: "http://127.0.0.1:2/v1",
  model: "embed-a",
  apiKey: "$EMBED_KEY",
  dimension: 768,
  batchSize: 8,
};
const change = (draft, block, mode = "auto") => embeddingChange(draft, embeddingDraft(block), block, mode);

test("the source follows akm: an endpoint, a model alone on the default connection, else the built-in embedder", () => {
  assert.equal(embeddingSource(remote), "endpoint");
  assert.equal(embeddingSource({ model: "embed-a" }), "connection");
  assert.equal(embeddingSource({ batchSize: 8 }), "local");
  assert.equal(embeddingSource(undefined), "local");
  assert.deepEqual(embeddingDraft(remote), {
    source: "endpoint",
    model: "embed-a",
    endpoint: "http://127.0.0.1:2/v1",
    apiKey: "",
    dimension: "768",
  });
});

test("an untouched draft writes nothing, and a key reference held is never put in the draft", () => {
  assert.deepEqual(change(embeddingDraft(remote), remote), { set: {}, unset: [] });
  assert.equal(embeddingChanges(embeddingDraft(remote), embeddingDraft(remote)), 0);
});

test("a remote endpoint writes endpoint, model and dimension; a $VAR key is the block's apiKey", () => {
  const draft = {
    source: "endpoint",
    model: " embed-b ",
    endpoint: " http://h:1/v1 ",
    apiKey: "$K",
    dimension: "1024",
  };
  assert.deepEqual(change(draft, undefined, "off"), {
    set: {
      "embedding.model": "embed-b",
      "embedding.dimension": "1024",
      "embedding.endpoint": "http://h:1/v1",
      "embedding.apiKey": "$K",
      semanticSearchMode: "auto",
    },
    unset: [],
  });
});

test("a typed key is stored for the endpoint and never written to the config; it replaces a held reference", () => {
  const draft = { ...embeddingDraft(remote), apiKey: " sk-typed " };
  const result = change(draft, remote);
  assert.deepEqual(result, {
    set: {},
    unset: ["embedding.apiKey"],
    key: { key: "sk-typed", endpoint: remote.endpoint },
  });
  assert.ok(!JSON.stringify(result.set).includes("sk-typed"));
});

test("a new endpoint without a key drops the old reference; the same endpoint keeps it", () => {
  const moved = { ...embeddingDraft(remote), endpoint: "http://other:1/v1" };
  assert.deepEqual(change(moved, remote), {
    set: { "embedding.endpoint": "http://other:1/v1" },
    unset: ["embedding.apiKey"],
  });
  const renamed = { ...embeddingDraft(remote), model: "embed-c" };
  assert.deepEqual(change(renamed, remote), { set: { "embedding.model": "embed-c" }, unset: [] });
});

test("the default connection's model drops the endpoint and key; the built-in embedder drops those and the model", () => {
  const connection = { ...embeddingDraft(remote), source: "connection" };
  assert.deepEqual(change(connection, remote), { set: {}, unset: ["embedding.endpoint", "embedding.apiKey"] });
  const local = { ...embeddingDraft(remote), source: "local" };
  assert.deepEqual(change(local, remote), {
    set: {},
    unset: ["embedding.endpoint", "embedding.model", "embedding.apiKey"],
  });
  // Keys with no control stay: only the three above are ever unset.
  assert.ok(![...change(local, remote).unset].includes("embedding.batchSize"));
});

test("choosing an embedder turns semantic search on only when it is not already", () => {
  const local = { ...embeddingDraft(remote), source: "local" };
  assert.equal(change(local, remote, "off").set.semanticSearchMode, "auto");
  assert.equal(change(local, remote, "auto").set.semanticSearchMode, undefined);
});

test("what stops a draft", () => {
  const ok = { hasConnection: true };
  assert.deepEqual(embeddingErrors(embeddingDraft(undefined), ok), {});
  assert.deepEqual(
    Object.keys(embeddingErrors({ ...embeddingDraft(remote), model: "", endpoint: "nope", dimension: "0" }, ok)),
    ["model", "endpoint", "dimension"],
  );
  assert.match(
    embeddingErrors({ ...embeddingDraft({ model: "m" }), source: "connection" }, { hasConnection: false }).model,
    /No default connection/,
  );
  assert.deepEqual(embeddingErrors({ ...embeddingDraft(remote), source: "connection" }, ok), {});
});

test("only a new model or dimension means the next index embeds again; an endpoint alone does not", () => {
  const base = embeddingDraft(remote);
  assert.equal(reembeds({ ...base, endpoint: "http://other/v1" }, base), false);
  assert.equal(reembeds({ ...base, source: "connection" }, base), false);
  assert.equal(reembeds({ ...base, model: "embed-b" }, base), true);
  assert.equal(reembeds({ ...base, dimension: "" }, base), true);
  assert.equal(reembeds({ ...base, source: "local" }, base), true);
  assert.equal(reembeds(embeddingDraft(undefined), embeddingDraft(undefined)), false);
});

test("the key status names a reference or the endpoint a stored key belongs to, and warns when the endpoint moves", () => {
  const base = embeddingDraft(remote);
  assert.equal(keyStatus(remote, null, base, base), "Reading the key from $EMBED_KEY.");
  const bare = { endpoint: remote.endpoint, model: "m" };
  assert.equal(
    keyStatus(bare, "http://127.0.0.1:2/v1", embeddingDraft(bare), embeddingDraft(bare)),
    "A key is stored for http://127.0.0.1:2/v1.",
  );
  assert.equal(keyStatus(undefined, null, embeddingDraft(undefined), embeddingDraft(undefined)), "No key is set.");
  assert.match(
    keyStatus(remote, null, { ...base, endpoint: "http://other/v1" }, base),
    /enter one for the new endpoint/,
  );
});
