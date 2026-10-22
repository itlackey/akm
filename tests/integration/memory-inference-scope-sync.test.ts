// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: opens a real index database (akmIndex + filtered akmSearch) to
// prove a synced child's scope reaches scoped retrieval.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { assembleAsset } from "../../src/core/asset/asset-serialize";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { runMemoryInferencePass } from "../../src/indexer/passes/memory-inference";
import { scopeFromFrontmatter } from "../../src/indexer/passes/metadata";
import type { SearchSource } from "../../src/indexer/search/search-source";
import { _setChatCompletionForTests } from "../../src/llm/client";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;
let requests: number;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  requests = 0;
  fs.mkdirSync(path.join(storage.stashDir, "memories"), { recursive: true });
  overrideSeam(_setChatCompletionForTests, async () => {
    requests += 1;
    return JSON.stringify({ noChange: true });
  });
});
afterEach(() => storage.cleanup());

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
function run(sources: SearchSource[] = [{ path: storage.stashDir, isDefault: true, writable: true }]) {
  return runMemoryInferencePass({ config: config(), sources });
}
function memoryFile(name: string, root = storage.stashDir): string {
  return path.join(root, "memories", `${name}.md`);
}
function writeParent(fm: Record<string, unknown>, root = storage.stashDir): string {
  const file = memoryFile("tunnel", root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    assembleAsset({ inferenceProcessed: true, ...fm }, "The operator requested a tunnel restart."),
  );
  return file;
}
function writeChild(fm: Record<string, unknown>, root = storage.stashDir): string {
  const file = memoryFile("tunnel.derived", root);
  fs.writeFileSync(
    file,
    assembleAsset(
      {
        inferred: true,
        captureMode: "background",
        source: "memories/tunnel",
        description: "Tunnel restart was requested; completion unknown.",
        tags: ["tunnel", "restart"],
        derivedFrom: "tunnel",
        ...fm,
      },
      "# Tunnel restart request\n\nA restart was requested.\n",
    ),
  );
  return file;
}
function childScope(file: string) {
  return scopeFromFrontmatter(parseFrontmatter(fs.readFileSync(file, "utf8")).data);
}
/** Pin mtime in the past so an unwanted rewrite is visible even within one clock tick. */
function pinMtime(file: string): number {
  const past = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(file, past, past);
  return fs.statSync(file).mtimeMs;
}
async function searchUser(user: string) {
  return (await akmSearch({ query: "tunnel", filters: { user }, skipLogging: true })).hits.filter(
    (hit): hit is typeof hit & { ref: string; expandTo?: string } => "ref" in hit,
  );
}
async function reindex() {
  saveConfig({ ...config(), index: { memory: { enabled: false } } });
  await akmIndex({ stashDir: storage.stashDir, full: true });
}

test("an existing unscoped child of a scoped parent gets the parent's scope and becomes reachable under the filter", async () => {
  writeParent({ scope_user: "alice" });
  const child = writeChild({});
  await reindex();
  const before = await searchUser("alice");
  expect(before.some((hit) => hit.ref === "memories/tunnel.derived")).toBe(false);
  expect(before.find((hit) => hit.ref === "memories/tunnel")?.expandTo).toBeUndefined();

  const result = await run();
  expect(result).toMatchObject({ considered: 0, scopeSynced: 1, writtenFacts: 0 });
  expect(result.writtenPaths).toEqual([child]);
  expect(requests).toBe(0);
  expect(childScope(child)).toEqual({ user: "alice" });

  await reindex();
  const after = await searchUser("alice");
  expect(after.some((hit) => hit.ref === "memories/tunnel.derived")).toBe(true);
  expect(after.find((hit) => hit.ref === "memories/tunnel")?.expandTo).toBe("memories/tunnel.derived");
  expect(await searchUser("bob")).toHaveLength(0);
  expect((await run()).scopeSynced).toBe(0);
});

test("syncing the scope of a child with generation provenance keeps its generated, observed and updated", async () => {
  writeParent({ scope_user: "alice" });
  const provenance = {
    generated: { by: "akm/0.10.0", at: "2026-10-21T09:30:00.000Z" },
    observed: "2026-06-14",
    updated: "2026-10-21",
    evidence: "No completion event.",
    evidenceSources: ["sessions/claude/lab"],
  };
  const child = writeChild(provenance);
  expect((await run()).scopeSynced).toBe(1);
  const data = parseFrontmatter(fs.readFileSync(child, "utf8")).data;
  expect(data).toMatchObject(provenance);
  expect(childScope(child)).toEqual({ user: "alice" });
});

test("a later parent scope edit propagates to the child, including removal", async () => {
  const parent = writeParent({ scope_user: "alice" });
  const child = writeChild({ scope_user: "alice" });
  expect((await run()).scopeSynced).toBe(0);

  writeParent({ scope_user: "bob", scope_agent: "helper", scope_run: 42 });
  expect((await run()).scopeSynced).toBe(1);
  expect(childScope(child)).toEqual({ user: "bob", agent: "helper", run: "42" });
  expect(parseFrontmatter(fs.readFileSync(child, "utf8")).data.scope_run).toBe("42");

  writeParent({});
  expect((await run()).scopeSynced).toBe(1);
  expect(childScope(child)).toEqual({});
  expect(Object.keys(parseFrontmatter(fs.readFileSync(child, "utf8")).data).some((k) => k.startsWith("scope"))).toBe(
    false,
  );
  expect(fs.existsSync(parent)).toBe(true);
});

test("a child whose scope already matches is not rewritten (bytes and mtime)", async () => {
  writeParent({ scope_user: " alice ", scope_run: 7 });
  const child = writeChild({ scope_user: "alice", scope_run: "7" });
  const bytes = fs.readFileSync(child, "utf8");
  const mtime = pinMtime(child);
  const result = await run();
  expect(result.scopeSynced).toBe(0);
  expect(result.writtenPaths).toEqual([]);
  expect(fs.readFileSync(child, "utf8")).toBe(bytes);
  expect(fs.statSync(child).mtimeMs).toBe(mtime);
});

test("only the scope lines change: body and other frontmatter are preserved byte for byte", async () => {
  writeParent({ scope_user: "bob", scope_channel: "lab" });
  const child = memoryFile("tunnel.derived");
  const head = [
    "---",
    "# authored comment",
    "inferred: true",
    "title: 'Quoted: title'",
    "tags: [tunnel, restart]",
    "derivedFrom: tunnel",
    "source: memories/tunnel",
  ];
  const body = '\n\nBody line one\n  indented "quoted" line\n---\nnot frontmatter';
  fs.writeFileSync(child, [...head, "scope_user: alice", "scope_agent: stale", "---", body].join("\n"));
  expect((await run()).scopeSynced).toBe(1);
  expect(fs.readFileSync(child, "utf8")).toBe(
    [...head, "scope_user: bob", "scope_channel: lab", "---", body].join("\n"),
  );
});

test("files that are not this parent's inferred child are never touched", async () => {
  writeParent({ scope_user: "alice" });
  const child = writeChild({ inferred: false });
  const notInferred = fs.readFileSync(child, "utf8");
  expect((await run()).scopeSynced).toBe(0);
  expect(fs.readFileSync(child, "utf8")).toBe(notInferred);

  writeChild({ derivedFrom: "other" });
  const otherParent = fs.readFileSync(child, "utf8");
  expect((await run()).scopeSynced).toBe(0);
  expect(fs.readFileSync(child, "utf8")).toBe(otherParent);

  // No parent file at all: an orphaned child keeps its scope.
  fs.rmSync(memoryFile("tunnel"));
  writeChild({ scope_user: "bob" });
  const orphan = fs.readFileSync(child, "utf8");
  expect((await run()).scopeSynced).toBe(0);
  expect(fs.readFileSync(child, "utf8")).toBe(orphan);
});

test("a read-only bundle is skipped without error", async () => {
  writeParent({ scope_user: "alice" });
  const child = writeChild({});
  const bytes = fs.readFileSync(child, "utf8");
  const readOnly = await run([{ path: storage.stashDir, isDefault: true, writable: false }]);
  expect(readOnly).toMatchObject({ scopeSynced: 0, writtenPaths: [] });
  expect(fs.readFileSync(child, "utf8")).toBe(bytes);

  // A non-default bundle is never a write target, writable or not.
  const other = path.join(storage.stashDir, "..", "other-bundle");
  writeParent({ scope_user: "alice" }, other);
  const otherChild = writeChild({}, other);
  const otherBytes = fs.readFileSync(otherChild, "utf8");
  const result = await run([
    { path: storage.stashDir, isDefault: true, writable: true },
    { path: other, writable: false },
  ]);
  expect(result.scopeSynced).toBe(1);
  expect(fs.readFileSync(otherChild, "utf8")).toBe(otherBytes);
});

test("legacy nested scope on the parent or child normalizes to the flat keys", async () => {
  writeParent({ scope: { user: " alice ", run: 3 } });
  const child = writeChild({ scope: { user: "old", agent: "stale" } });
  expect((await run()).scopeSynced).toBe(1);
  const data = parseFrontmatter(fs.readFileSync(child, "utf8")).data;
  expect(data.scope).toBeUndefined();
  expect(data).toMatchObject({ scope_user: "alice", scope_run: "3" });
  expect(data.scope_agent).toBeUndefined();

  // Legacy nested on the child that already normalizes to the parent's tuple: no write.
  writeChild({ scope: { user: "alice", run: "3" } });
  const bytes = fs.readFileSync(child, "utf8");
  const mtime = pinMtime(child);
  expect((await run()).scopeSynced).toBe(0);
  expect(fs.readFileSync(child, "utf8")).toBe(bytes);
  expect(fs.statSync(child).mtimeMs).toBe(mtime);
});
