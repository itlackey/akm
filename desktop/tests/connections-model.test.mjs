// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectionChange,
  connectionChanges,
  connectionDraft,
  connectionEntry,
  connectionErrors,
  connectionSummary,
  defaultFirst,
  deletionImpact,
  newConnectionDraft,
  optionsText,
} from "../src/lib/connections-model.ts";

const lab = {
  endpoint: "http://127.0.0.1:2/lab/v1",
  apiKey: "$LAB_KEY",
  models: { fast: "lab-small", judge: { model: "lab-large", temperature: 0, reasoning_effort: "high" }, extra: "x" },
  contextLength: 131072,
  timeoutMs: 120000,
  concurrency: 2,
  top_p: 0.9,
  chat_template_kwargs: { enable_thinking: false },
  apiKeyFile: "/old/key",
};

test("an untouched draft writes the entry back exactly: custom aliases, object models, options, retired keys, order", () => {
  const entry = connectionEntry(connectionDraft("lab", lab), lab);
  assert.deepEqual(entry, lab);
  assert.equal(JSON.stringify(entry), JSON.stringify(lab));
  assert.equal(connectionChanges(connectionDraft("lab", lab), connectionDraft("lab", lab)), 0);
});

test("only what changed is rewritten; a string model gains object form only with options", () => {
  const draft = connectionDraft("lab", lab);
  draft.models[0].model = "lab-tiny";
  draft.models[2].options = '{"max_tokens": 50}';
  draft.concurrency = "4";
  draft.options = '{"top_p": 0.5}';
  const entry = connectionEntry(draft, lab);
  assert.deepEqual(entry.models, {
    fast: "lab-tiny",
    judge: lab.models.judge,
    extra: { model: "x", max_tokens: 50 },
  });
  assert.equal(entry.concurrency, 4);
  assert.deepEqual([entry.top_p, entry.chat_template_kwargs, entry.apiKeyFile], [0.5, undefined, "/old/key"]);
  assert.equal(entry.endpoint, lab.endpoint);
  assert.equal(connectionChanges(draft, connectionDraft("lab", lab)), 4);
});

test("removing an alias, clearing a field and choosing no timeout are written as such", () => {
  const draft = connectionDraft("lab", lab);
  draft.models.splice(1, 1);
  draft.contextLength = "";
  draft.noTimeout = true;
  draft.apiKey = "";
  const entry = connectionEntry(draft, lab);
  assert.deepEqual(Object.keys(entry.models), ["fast", "extra"]);
  assert.equal("contextLength" in entry, false);
  assert.equal("apiKey" in entry, false);
  assert.equal(entry.timeoutMs, null);
});

test("a new connection starts with fast, balanced and reasoning and validates by field", () => {
  const draft = newConnectionDraft();
  assert.deepEqual(
    draft.models.map((row) => row.alias),
    ["fast", "balanced", "reasoning"],
  );
  const errors = connectionErrors(draft, { existing: ["default"], creating: true });
  assert.equal(errors.name, "Enter a name.");
  assert.match(errors.endpoint, /http or https/);
  assert.equal(errors["model-0"], undefined, "blank alias rows are not checked");
  Object.assign(draft, { name: "default", endpoint: "https://x.test/v1", apiKey: "sk-secret" });
  draft.models.forEach((row) => (row.model = "m"));
  assert.match(connectionErrors(draft, { existing: ["default"], creating: true }).name, /already exists/);
  draft.name = "akm-x";
  assert.match(connectionErrors(draft, { existing: [], creating: true }).name, /lowercase/);
  draft.name = "lab-1";
  assert.match(connectionErrors(draft, { existing: [], creating: true }).apiKey, /not the key itself/);
  draft.apiKey = "$KEY";
  draft.models[1].alias = "fast";
  draft.options = '{"endpoint": "x"}';
  draft.contextLength = "0";
  const errors2 = connectionErrors(draft, { existing: [], creating: true });
  assert.deepEqual(Object.keys(errors2).sort(), ["alias-1", "contextLength", "options"]);
  assert.match(errors2.options, /set by the field above/);
  draft.options = "[1]";
  assert.match(connectionErrors(draft, { existing: [], creating: true }).options, /JSON object/);
});

test("a save sends the whole entry under its name", () => {
  assert.deepEqual(connectionChange(" lab ", { endpoint: "http://x/v1" }), {
    name: "lab",
    entry: { endpoint: "http://x/v1" },
  });
});

test("summaries and deletion impact use akm's default rule", () => {
  assert.equal(connectionSummary(lab), "Models fast, judge, extra · Key $LAB_KEY");
  assert.equal(
    connectionSummary({ models: { a: "1", b: "2", c: "3", d: "4", e: "5" } }),
    "Models a, b, c, +2 · No key",
  );
  assert.equal(optionsText({ top_p: 0.9, t: { a: 1 }, s: "x" }), 'top_p: 0.9, t: {"a":1}, s: "x"');
  const row = { name: "default", usedBy: ["improve.connection"] };
  assert.match(deletionImpact(row, ["default", "lab"], "default").defaultLine, /lab becomes the default/);
  assert.match(deletionImpact(row, ["default", "a", "b"], "default").defaultLine, /no connection is the default/);
  assert.equal(deletionImpact({ name: "lab" }, ["default", "lab"], "default").defaultLine, "");
});

test("a row from config.get() is stripped to its configured entry before it is edited or shown", async () => {
  const { entryOf, requestOptions } = await import("../src/lib/connections-model.ts");
  const row = { name: "lab", inherited: false, usedBy: ["improve.connection"], endpoint: "http://x/v1", top_p: 0.9 };
  assert.deepEqual(entryOf(row), { endpoint: "http://x/v1", top_p: 0.9 });
  assert.deepEqual(requestOptions(entryOf(row)), { top_p: 0.9 });
  assert.deepEqual(connectionEntry(connectionDraft("lab", entryOf(row)), entryOf(row)), entryOf(row));
});

test("clearing a model's options writes it back as a plain string; adding them makes it an object again", () => {
  const draft = connectionDraft("lab", lab);
  draft.models[1].options = "";
  assert.equal(connectionEntry(draft, lab).models.judge, "lab-large");
  assert.equal(connectionChanges(draft, connectionDraft("lab", lab)), 1);
  draft.models[1].options = '{"temperature": 0.5}';
  assert.deepEqual(connectionEntry(draft, lab).models.judge, { model: "lab-large", temperature: 0.5 });
});

test("alias rows left blank are neither checked nor written", () => {
  const draft = newConnectionDraft();
  Object.assign(draft, { name: "x", endpoint: "https://x.test/v1" });
  draft.models[0].model = "m";
  assert.deepEqual(connectionErrors(draft, { existing: [], creating: true }), {});
  assert.deepEqual(connectionEntry(draft, {}).models, { fast: "m" });
  draft.models[1].options = "{}";
  assert.equal(connectionErrors(draft, { existing: [], creating: true })["model-1"], "Enter the model name.");
});

test("the default connection is listed first", () => {
  assert.deepEqual(
    defaultFirst([{ name: "shared" }, { name: "default" }, { name: "lab" }], "default").map((r) => r.name),
    ["default", "shared", "lab"],
  );
});
