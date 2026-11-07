// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  draftErrors,
  projectChange,
  projectDraft,
  projectEntry,
  projectRows,
  projectSummary,
} from "../src/lib/projects-model.ts";

const acme = {
  paths: ["~/clients/acme", "/work/acme"],
  from: ["acme-team", "personal"],
  filters: { channel: ["acme", ""], team: "platform" },
  prefer: { team: "platform" },
  write: { bundle: "acme-team", channel: "acme", metadata: { team: "platform", year: 2026, draft: true } },
};

test("an entry round-trips through its draft unchanged, empty filter values and metadata types included", () => {
  const draft = projectDraft("acme", acme);
  assert.deepEqual(draft.filters, [
    { key: "channel", values: "acme", absent: true },
    { key: "team", values: "platform", absent: false },
  ]);
  assert.equal(draft.paths, "~/clients/acme\n/work/acme");
  assert.deepEqual(projectEntry(draft, acme), acme);
});

test("a draft becomes a minimal entry: blanks are left out, one value stays a string, absence is an empty value", () => {
  const draft = projectDraft("bare");
  assert.deepEqual(projectEntry(draft), {});
  draft.paths = " /work/a \n\n/work/b ";
  draft.from = ["one"];
  draft.filters = [
    { key: " channel ", values: " acme \n\n a,b ", absent: true },
    { key: "team", values: "", absent: false },
    { key: "", values: "x", absent: false },
    { key: "only-absent", values: "", absent: true },
  ];
  draft.channel = " acme ";
  draft.metadata = [
    { key: "team", value: "platform" },
    { key: " ", value: "dropped" },
  ];
  assert.deepEqual(projectEntry(draft), {
    paths: ["/work/a", "/work/b"],
    from: "one",
    filters: { channel: ["acme", "a,b", ""], "only-absent": "" },
    write: { channel: "acme", metadata: { team: "platform" } },
  });
});

test("editing keeps the fields Desktop has no control for, and a metadata value that was edited becomes text", () => {
  const original = { ...acme, extra: { keep: 1 }, write: { ...acme.write, other: "kept" } };
  const draft = projectDraft("acme", original);
  draft.metadata[1].value = "2027";
  const entry = projectEntry(draft, original);
  assert.deepEqual(entry.extra, { keep: 1 });
  assert.equal(entry.write.other, "kept");
  assert.equal(entry.write.metadata.year, "2027");
  assert.equal(entry.write.metadata.draft, true);
});

test("a rename sets the new name and unsets the old one; an unchanged name unsets nothing", () => {
  const draft = projectDraft("acme", acme);
  assert.deepEqual(projectChange(draft, { name: "acme", entry: acme }), { set: { acme } });
  draft.name = " acme.corp ";
  assert.deepEqual(projectChange(draft, { name: "acme", entry: acme }), {
    set: { "acme.corp": acme },
    unset: ["acme"],
  });
  assert.deepEqual(projectChange(projectDraft("new"), null), { set: { new: {} } });
});

test("saving an unchanged draft gives the entry back exactly, whatever its shape", () => {
  const entries = [
    { paths: ["/a"], from: ["one"], filters: { channel: ["", "acme"], team: ["x"], list: "a,b" }, prefer: {} },
    { paths: [], write: {}, filters: {} },
    { from: "one", write: { metadata: { n: 1 } }, extra: 1 },
    {},
  ];
  for (const entry of entries) {
    const entryOut = projectEntry(projectDraft("p", entry), entry);
    assert.equal(JSON.stringify(entryOut), JSON.stringify(entry));
  }
  // Changing one row leaves the others as they were.
  const entry = entries[0];
  const draft = projectDraft("p", entry);
  draft.filters[1].values = "y";
  assert.deepEqual(projectEntry(draft, entry).filters, { channel: ["", "acme"], team: "y", list: "a,b" });
});

test("a key named twice in one list is a form error, not a silent overwrite", () => {
  const draft = projectDraft("p");
  draft.filters = [
    { key: "team", values: "a", absent: false },
    { key: " team", values: "b", absent: false },
  ];
  draft.metadata = [
    { key: "k", value: "1" },
    { key: "k", value: "2" },
  ];
  assert.deepEqual(draftErrors(draft), ['Filters name "team" twice.', 'Metadata names "k" twice.']);
  assert.deepEqual(draftErrors(projectDraft("p", acme)), []);
});

test("rows are inherited unless the config file holds them, and summaries name what a project sets", () => {
  const rows = projectRows({ acme: {}, "acme.corp": {}, base: {} }, ["acme"]);
  assert.deepEqual(
    rows.map((row) => [row.name, row.inherited]),
    [
      ["acme", false],
      ["acme.corp", true],
      ["base", true],
    ],
  );
  assert.deepEqual(projectSummary(acme), [
    "Reads acme-team, personal",
    "Filters channel, team",
    "Prefers team",
    "Writes to acme-team",
  ]);
  assert.deepEqual(projectSummary({ paths: ["/a"] }), []);
  assert.deepEqual(projectRows(undefined, []), []);
});
