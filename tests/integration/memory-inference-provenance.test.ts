// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration (#1210): a derived memory carries truthful generation provenance
// and keeps its source's historical facts distinct from it. Real inference
// writes, index database, show and the provenance reader, under a fixed clock.
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmShowUnified } from "../../src/commands/read/show";
import { assembleAsset } from "../../src/core/asset/asset-serialize";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { runMemoryInferencePass } from "../../src/indexer/passes/memory-inference";
import { applyProvenanceFrontmatter, type IndexDocument } from "../../src/indexer/passes/metadata";
import { _setChatCompletionForTests } from "../../src/llm/client";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { pkgVersion } from "../../src/version";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const NOW = "2026-10-21T09:30:00.000Z";
const TODAY = "2026-10-21";

let storage: IsolatedAkmStorage;
let requests: string[];
let reply: object;

const draft = {
  noChange: false,
  title: "June VPN tunnel outage",
  description: "On 2026-06-14 the lab VPN tunnel dropped; a restart was requested and its completion is unknown.",
  content: "Observed 2026-06-14: the lab VPN tunnel dropped and a restart was requested. No completion was recorded.",
  tags: ["lab", "vpn", "tunnel"],
  searchHints: ["vpn outage june", "tunnel restart request", "completion unknown"],
};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  requests = [];
  reply = draft;
  fs.mkdirSync(path.join(storage.stashDir, "memories"), { recursive: true });
  overrideSeam(_setChatCompletionForTests, async (_config, messages) => {
    requests.push(messages.find((m) => m.role === "user")?.content ?? "");
    return JSON.stringify(reply);
  });
  setSystemTime(new Date(NOW));
});
afterEach(() => {
  setSystemTime();
  storage.cleanup();
});

function config() {
  return {
    semanticSearchMode: "off" as const,
    bundles: { stash: { path: storage.stashDir } },
    defaultBundle: "stash",
    engines: {
      memory: { kind: "llm" as const, endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "scripted" },
    },
    index: { defaults: { engine: "memory" } },
  };
}
const parentFile = () => path.join(storage.stashDir, "memories", "tunnel.md");
const childFile = () => path.join(storage.stashDir, "memories", "tunnel.derived.md");
function writeParent(
  fm: Record<string, unknown>,
  body = "The lab VPN tunnel dropped; the operator asked for a restart.",
) {
  fs.writeFileSync(parentFile(), assembleAsset(fm, body));
}
function runPass() {
  return runMemoryInferencePass({ config: config(), sources: [{ path: storage.stashDir, isDefault: true }] });
}
async function infer() {
  const result = await runPass();
  return { result, child: parseFrontmatter(fs.readFileSync(childFile(), "utf8")) };
}
/** The child as the index stores it. */
async function indexedChild() {
  saveConfig({ ...config(), index: { memory: { enabled: false } } });
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const db = openExistingDatabase(getDbPath());
  try {
    const row = db.prepare("SELECT document_json FROM entries WHERE file_path = ?").get(childFile()) as {
      document_json: string;
    };
    return JSON.parse(row.document_json) as IndexDocument;
  } finally {
    closeDatabase(db);
  }
}

test("an old observation summarized today keeps its date and gains truthful, deterministic generation metadata", async () => {
  writeParent({
    description: "Lab VPN note",
    observed_at: "2026-06-14",
    updated: "2026-06-15",
    evidence: "Operator requested restart; no completion event.",
    evidenceSources: ["sessions/claude/lab"],
    provenance: { sources: [{ resource: "claude:lab-session" }] },
    verified: [{ by: "human:someone", at: "2026-06-16T00:00:00.000Z" }],
  });
  const { result, child } = await infer();
  expect(result.writtenFacts).toBe(1);

  // Generation: deterministic identity and time, in the existing `generated: {by, at}` shape.
  expect(child.data.generated).toEqual({ by: `akm/${pkgVersion}`, at: NOW });
  // File modification stays the child write date; it is not backdated to the observation.
  expect(child.data.updated).toBe(TODAY);
  // Observation: the source's explicit date is retained verbatim, as its own field.
  expect(child.data.observed_at).toBe("2026-06-14");
  // The model's historical description and body are published as returned.
  expect(child.data.description).toBe(draft.description);
  expect(child.content).toContain("Observed 2026-06-14");
  // Verification: neither the source's verification nor a new one is attached to the compression.
  expect(child.data.verified).toBeUndefined();
  expect(JSON.stringify(child.data)).not.toContain("someone");
  // The clock never reaches the model: the generation instant is not request input.
  expect(requests[0]).not.toContain(TODAY);
  expect(requests[0]).toContain("2026-06-14");
  // Evidence and source identities (not generation time) are retained from the parent.
  expect(child.data.source).toBe("memories/tunnel");
  expect(child.data.derivedFrom).toBe("tunnel");
  expect(child.data.evidence).toBe("Operator requested restart; no completion event.");
  expect(child.data.evidenceSources).toEqual(["sessions/claude/lab"]);
  expect(child.data.provenance).toEqual({ sources: [{ resource: "claude:lab-session" }] });
  // The parent is only stamped processed.
  const parent = parseFrontmatter(fs.readFileSync(parentFile(), "utf8")).data;
  expect(parent.generated).toBeUndefined();
  expect(parent.observed_at).toBe("2026-06-14");
});

test("a date held only in parent metadata reaches the model and survives on the child through the index", async () => {
  writeParent(
    { description: "Lab VPN note", observed_at: "2026-06-14" },
    "The lab VPN tunnel dropped; restart requested.",
  );
  const { child } = await infer();
  const context = JSON.parse(requests[0]?.split("Source context:\n")[1]?.split("\n\nBody:\n")[0] ?? "{}");
  expect(context.observed_at).toBe("2026-06-14");
  expect(child.data.observed_at).toBe("2026-06-14");
  const indexed = await indexedChild();
  expect(indexed.searchHints).toContain("observed_at:2026-06-14");
  expect(indexed.searchHints).not.toContain(`observed_at:${TODAY}`);
});

test("a source with no observation date gets none: not from updated, mtime or the generation clock", async () => {
  writeParent({ description: "Lab VPN note", created: "2026-03-01", updated: "2026-03-02" });
  const { child } = await infer();
  expect(child.data.observed_at).toBeUndefined();
  expect(child.data.created).toBeUndefined();
  // `updated` is the child's own write date, never the source's, and is not an event date.
  expect(child.data.updated).toBe(TODAY);
  // Nor does the index invent one from the child's mtime, which is its generation time.
  const indexed = await indexedChild();
  expect((indexed.searchHints ?? []).filter((hint) => hint.startsWith("observed_at:"))).toEqual([]);
  expect(child.data.generated).toEqual({ by: `akm/${pkgVersion}`, at: NOW });
});

test("a source with no evidence or references leaves the child without invented ones", async () => {
  writeParent({ description: "Lab VPN note" });
  const { child } = await infer();
  for (const key of ["evidence", "evidenceSources", "provenance", "verified", "observed_at"])
    expect(child.data[key]).toBeUndefined();
});

test("source qualifications reach the model and the child keeps them with its provenance through file, index and show", async () => {
  writeParent({
    description: "Lab route; not proof of this assistant's configuration.",
    observed_at: "2026-06-14",
    evidence: "Operator requested restart; no completion event.",
    evidenceSources: ["sessions/claude/lab"],
  });
  const { child } = await infer();
  expect(requests[0]).toContain("no completion event");
  expect(child.data.description).toContain("completion is unknown");
  expect(child.content).toContain("No completion was recorded");

  const indexed = await indexedChild();
  expect(indexed.derivedFrom).toBe("memories/tunnel");
  expect(indexed.evidence).toBe("Operator requested restart; no completion event.");
  expect(indexed.evidenceSources).toEqual(["sessions/claude/lab"]);
  expect(indexed.provenance).toEqual({ generatedBy: `akm/${pkgVersion}`, generatedAt: NOW });

  const shown = await akmShowUnified({ ref: "memories/tunnel.derived", skipLogging: true });
  expect(shown.evidence).toBe("Operator requested restart; no completion event.");
  expect(shown.evidenceSources).toEqual(["sessions/claude/lab"]);
  expect(shown.provenance).toEqual({ generatedBy: `akm/${pkgVersion}`, generatedAt: NOW });
  // The parent link resolves.
  expect((await akmShowUnified({ ref: "memories/tunnel", skipLogging: true })).ref).toContain("memories/tunnel");

  // The existing provenance reader, applied to the file as written, agrees with the index.
  const read: IndexDocument = { type: "memory", name: "tunnel.derived" };
  applyProvenanceFrontmatter(read, child.data);
  expect(read.provenance).toEqual({ generatedBy: `akm/${pkgVersion}`, generatedAt: NOW });
});

test("a replayed identical reply later stamps the later generation time and nothing else differs", async () => {
  writeParent({ description: "Lab VPN note", observed_at: "2026-06-14" });
  const first = (await infer()).child;
  fs.rmSync(childFile());
  fs.writeFileSync(parentFile(), fs.readFileSync(parentFile(), "utf8").replace("inferenceProcessed: true\n", ""));
  setSystemTime(new Date("2026-10-22T01:02:03.000Z"));
  const second = (await infer()).child;
  expect(second.data.generated).toEqual({ by: `akm/${pkgVersion}`, at: "2026-10-22T01:02:03.000Z" });
  expect({ ...second.data, generated: undefined, updated: undefined }).toEqual({
    ...first.data,
    generated: undefined,
    updated: undefined,
  });
  expect(second.content).toBe(first.content);
});

test("a no-change decision writes no child and stamps no generation or verification", async () => {
  reply = { noChange: true };
  writeParent({ description: "Lab VPN note", observed_at: "2026-06-14" });
  const before = fs.readFileSync(parentFile(), "utf8");
  const result = await runPass();
  expect(result).toMatchObject({ noChange: 1, writtenFacts: 0 });
  expect(fs.existsSync(childFile())).toBe(false);
  expect(fs.readFileSync(parentFile(), "utf8")).toBe(before);
});

test("a note derived before this change still indexes, shows and reads without a rewrite", async () => {
  const legacy = assembleAsset(
    {
      inferred: true,
      captureMode: "background",
      source: "memories/tunnel",
      description: draft.description,
      tags: draft.tags,
      searchHints: draft.searchHints,
      title: draft.title,
      derivedFrom: "tunnel",
      updated: "2026-09-01",
    },
    `# ${draft.title}\n\n${draft.content}\n`,
  );
  fs.writeFileSync(childFile(), legacy);
  writeParent({ description: "Lab VPN note", observed_at: "2026-06-14", inferenceProcessed: true });
  const result = await runPass();
  expect(result.considered).toBe(0);
  expect(fs.readFileSync(childFile(), "utf8")).toBe(legacy);
  const indexed = await indexedChild();
  expect(indexed.provenance).toBeUndefined();
  expect(indexed.derivedFrom).toBe("memories/tunnel");
  const shown = await akmShowUnified({ ref: "memories/tunnel.derived", skipLogging: true });
  expect(JSON.stringify(shown)).toContain("restart was requested");
  expect(shown.provenance).toBeUndefined();
});
