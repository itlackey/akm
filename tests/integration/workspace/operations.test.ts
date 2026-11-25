// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createProposal } from "../../../src/commands/proposal/repository";
import { saveConfig } from "../../../src/core/config/config";
import { CONFLICT_CODES } from "../../../src/core/errors";
import { readEvents } from "../../../src/core/events";
import { acquireAssetMutationLease } from "../../../src/core/index-writer-lock";
import { akmIndex } from "../../../src/indexer/indexer";
import { assets, documents, proposals, sensitive } from "../../../src/workspace";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const note = () => path.join(storage.stashDir, "knowledge", "note.md");

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    registries: [],
  });
  fs.mkdirSync(path.dirname(note()), { recursive: true });
  fs.writeFileSync(note(), "---\ndescription: a note\n---\nOriginal.\n");
  fs.writeFileSync(path.join(storage.stashDir, "knowledge", "other.md"), "---\ndescription: other\n---\nOther.\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => storage.cleanup());

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { code?: string }) => error.code,
  );

test("a proposal decision twice is PROPOSAL_NOT_PENDING, and a changed target is PROPOSAL_STALE", async () => {
  const stale = createProposal(storage.stashDir, {
    ref: "stash//knowledge/note",
    source: "reflect",
    payload: { content: "---\ndescription: a note\n---\nProposed.\n" },
  });
  fs.writeFileSync(note(), "---\ndescription: a note\n---\nEdited meanwhile.\n");
  expect(await code(proposals.accept({ id: stale.id }))).toBe("PROPOSAL_STALE");
  await proposals.reject({ id: stale.id, reason: "stale" });
  expect(await code(proposals.accept({ id: stale.id }))).toBe("PROPOSAL_NOT_PENDING");
  expect(await code(proposals.reject({ id: stale.id, reason: "again" }))).toBe("PROPOSAL_NOT_PENDING");
  expect(CONFLICT_CODES.has("PROPOSAL_STALE") && CONFLICT_CODES.has("PROPOSAL_NOT_PENDING")).toBe(true);
});

test("a batch carries the code of each failed id", async () => {
  const good = createProposal(storage.stashDir, {
    ref: "stash//knowledge/other",
    source: "reflect",
    payload: { content: "---\ndescription: other\n---\nBetter.\n" },
  });
  const gone = createProposal(storage.stashDir, {
    ref: "stash//knowledge/note",
    source: "reflect",
    payload: { content: "---\ndescription: a note\n---\nProposed.\n" },
  });
  fs.writeFileSync(note(), "---\ndescription: a note\n---\nEdited meanwhile.\n");
  const accepted = (await proposals.acceptMany({ ids: [good.id, gone.id, "no-such-id"] })) as {
    results: Array<{ ok: boolean; id: string; code?: string }>;
  };
  expect(accepted.results.map((r) => [r.ok, r.code])).toEqual([
    [true, undefined],
    [false, "PROPOSAL_STALE"],
    [false, "PROPOSAL_NOT_FOUND"],
  ]);
  const rejected = (await proposals.rejectMany({ ids: [good.id], reason: "late" })) as unknown as {
    results: Array<{ ok: boolean; code?: string }>;
  };
  expect(rejected.results[0]).toMatchObject({ ok: false, code: "PROPOSAL_NOT_PENDING" });
});

test("a write fails fast with ASSET_MUTATION_LEASE_HELD while another process holds the lease", async () => {
  const source = await documents.readSource({ ref: "stash//knowledge/note" });
  const lease = await acquireAssetMutationLease({ purpose: "test-holder", mode: "try" });
  try {
    const started = Date.now();
    expect(await code(documents.save({ ...source, content: `${source.content}Held.\n` }))).toBe(
      "ASSET_MUTATION_LEASE_HELD",
    );
    expect(await code(documents.retire({ ref: source.ref, revision: source.revision }))).toBe(
      "ASSET_MUTATION_LEASE_HELD",
    );
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    lease?.release();
  }
  expect(fs.existsSync(note())).toBe(true);
}, 15_000);

test("a shown asset says where its body starts in the text it is read from", async () => {
  const shown = (await assets.show({ ref: "stash//knowledge/note" })) as {
    asset: { content?: string };
    bodyStart: number;
  };

  expect(shown.asset.content?.slice(shown.bodyStart).trim()).toBe("Original.");
  expect(shown.asset.content?.slice(0, shown.bodyStart)).toContain("description: a note");
});

test("env and secret writes check the revision with the bytes they replace or remove", async () => {
  const created = await sensitive.save({ bundle: "stash", file: "env/app.env", content: "A=1\n" });
  expect(created).toMatchObject({ bundle: "stash", ref: "stash//env/app", revision: sha("A=1\n"), warnings: [] });
  expect(await code(sensitive.save({ ref: created.ref, content: "A=2\n" }))).toBe("RESOURCE_ALREADY_EXISTS");
  const info = sensitive.describe({ ref: created.ref });
  expect(info).toMatchObject({
    type: "env",
    actions: { edit: { allowed: true }, delete: { allowed: true } },
    revision: created.revision,
  });
  expect(JSON.stringify(info)).not.toContain("A=1");
  expect(await code(sensitive.save({ ref: created.ref, content: "A=3\n", revision: sha("old") }))).toBe(
    "ASSET_CONTENT_CHANGED",
  );
  expect(await code(sensitive.remove({ ref: created.ref, revision: sha("old") }))).toBe("ASSET_CONTENT_CHANGED");
  expect(sensitive.readValue({ ref: created.ref }).content).toBe("A=1\n");
  const saved = await sensitive.save({ ref: created.ref, content: "A=4\n", revision: created.revision });
  expect(saved.revision).toBe(sha("A=4\n"));
  expect(await sensitive.remove({ ref: created.ref, revision: saved.revision })).toMatchObject({ removed: true });
  expect(fs.existsSync(info.path as string)).toBe(false);
});

test("a protected file in a read-only bundle says why it cannot be edited or deleted, in the sentence akm's own write refuses with", async () => {
  const locked = path.join(storage.root, "locked-bundle");
  fs.mkdirSync(path.join(locked, "env"), { recursive: true });
  fs.writeFileSync(path.join(locked, "env", "ro.env"), "A=1\n");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true }, locked: { path: locked, writable: false } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    registries: [],
  });
  const info = sensitive.describe({ bundle: "locked", file: "env/ro.env" });
  const refusal = await sensitive
    .save({ bundle: "locked", file: "env/ro.env", content: "A=2\n", revision: info.revision })
    .then(
      () => "",
      (error: Error) => error.message,
    );
  expect(refusal).not.toBe("");
  expect(info.actions.edit).toEqual({ allowed: false, reason: refusal });
  expect(info.actions.delete).toEqual({ allowed: false, reason: refusal });
});

test("a protected file below the top level is named as one akm manages only at the top level, and nothing opens or changes it", async () => {
  const nested = path.join(storage.stashDir, "projects", "x", "secrets", "token");
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, "synthetic-nested-value");
  const selector = { bundle: "stash", file: "projects/x/secrets/token" };
  const refusal = /protected secret file that akm manages only at the top level of a bundle/;
  expect(() => sensitive.describe(selector)).toThrow(refusal);
  expect(() => sensitive.readValue(selector)).toThrow(refusal);
  await expect(
    sensitive.save({ ...selector, content: "planted", revision: sha("synthetic-nested-value") }),
  ).rejects.toThrow(refusal);
  await expect(sensitive.remove({ ...selector, revision: sha("synthetic-nested-value") })).rejects.toThrow(refusal);
  // The refusal carries no value, and the file is as it was.
  expect(() => sensitive.describe(selector)).not.toThrow(/synthetic-nested-value/);
  expect(fs.readFileSync(nested, "utf8")).toBe("synthetic-nested-value");
  // A file that is no protected file keeps the plain answer.
  expect(() => sensitive.describe({ bundle: "stash", file: "knowledge/note.md" })).toThrow(
    "Choose an environment file or secret.",
  );
});

test("createKnowledge writes, indexes and records the import as `akm import -` does, and refuses an existing name", async () => {
  const created = await documents.createKnowledge({
    bundle: "stash",
    name: "fresh",
    content: "# Fresh\n\nNew note.\n",
  });
  expect(fs.readFileSync(created.path, "utf8")).toContain("New note.");
  const shown = (await assets.show({ ref: "stash//knowledge/fresh" })) as { durableRef: string | null };
  expect(shown.durableRef).toBe("stash//knowledge/fresh");
  expect(readEvents({ type: "import" }).events.map((event) => event.metadata)).toContainEqual({
    source: "-",
    path: created.path,
    force: false,
  });
  expect(await code(documents.createKnowledge({ bundle: "stash", name: "fresh", content: "Again.\n" }))).toBe(
    "RESOURCE_ALREADY_EXISTS",
  );
});
