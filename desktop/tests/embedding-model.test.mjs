// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  embeddingAnswer,
  embeddingChanges,
  embeddingDraft,
  embeddingErrors,
  embeddingSource,
  keyStatus,
  reembeds,
} from "../src/lib/embedding-model.ts";

const remote = { endpoint: "http://127.0.0.1:2/v1", model: "embed-a", apiKey: "$EMBED_KEY", batchSize: 8 };

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
  });
  assert.equal(embeddingChanges(embeddingDraft(remote), embeddingDraft(remote)), 0);
});

test("the answer is what setup takes: a $VAR is a variable name, other text a pasted key, none no key", () => {
  const base = embeddingDraft(remote);
  assert.deepEqual(embeddingAnswer({ ...base, model: " m ", endpoint: " http://h:11434 " }), {
    kind: "endpoint",
    endpoint: "http://h:11434",
    model: "m",
  });
  assert.deepEqual(embeddingAnswer({ ...base, apiKey: " $K " }).key, { env: "K" });
  assert.deepEqual(embeddingAnswer({ ...base, apiKey: " sk-typed " }).key, { pasted: "sk-typed" });
  assert.deepEqual(embeddingAnswer({ ...base, source: "connection", apiKey: "sk-x" }), {
    kind: "connection",
    model: "embed-a",
  });
  assert.deepEqual(embeddingAnswer({ ...base, source: "local" }), { kind: "local" });
});

test("what stops a draft", () => {
  const ok = { hasConnection: true };
  assert.deepEqual(embeddingErrors(embeddingDraft(undefined), ok), {});
  assert.deepEqual(Object.keys(embeddingErrors({ ...embeddingDraft(remote), model: "", endpoint: "nope" }, ok)), [
    "model",
    "endpoint",
  ]);
  assert.match(
    embeddingErrors({ ...embeddingDraft({ model: "m" }), source: "connection" }, { hasConnection: false }).model,
    /No default connection/,
  );
  assert.deepEqual(embeddingErrors({ ...embeddingDraft(remote), source: "connection" }, ok), {});
});

test("only another model, or local against remote, means the next index embeds again", () => {
  const base = embeddingDraft(remote);
  assert.equal(reembeds({ ...base, endpoint: "http://other/v1", apiKey: "$K" }, base), false);
  assert.equal(reembeds({ ...base, source: "connection" }, base), false);
  assert.equal(reembeds({ ...base, model: "embed-b" }, base), true);
  assert.equal(reembeds({ ...base, source: "local" }, base), true);
  assert.equal(reembeds(embeddingDraft(undefined), embeddingDraft(undefined)), false);
  assert.equal(reembeds({ ...embeddingDraft(undefined), model: "ignored" }, embeddingDraft(undefined)), false);
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
