// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { projectChange, projectDraft, projectEntry, projectRows, projectSummary } from "../src/lib/projects-model.ts";

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
    { key: " channel ", values: " acme ,, ", absent: true },
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
    filters: { channel: ["acme", ""], "only-absent": "" },
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

test("rows say which projects are only inherited, and summaries name what a project sets", () => {
  const rows = projectRows({ mine: { paths: ["/a"] }, base: { paths: ["/b"] }, mixed: { paths: ["/c"], from: "x" } }, [
    { path: "projects.mine.paths", source: "file" },
    { path: "projects.base.paths", source: "extends:team.json" },
    { path: "projects.mixed.paths", source: "extends:team.json" },
    { path: "projects.mixed.from", source: "file" },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.name, row.inherited]),
    [
      ["mine", false],
      ["base", true],
      ["mixed", false],
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
