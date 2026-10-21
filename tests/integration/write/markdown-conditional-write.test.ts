// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeMarkdownAsset } from "../../../src/commands/read/knowledge";
import { akmSearch } from "../../../src/commands/read/search";
import { acquireAssetMutationLease, withAssetMutationLease } from "../../../src/indexer/index-writer-lock";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeLockfile } from "../../../src/integrations/lockfile";
import { git, makeGitRepo } from "../../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const RAW =
  "---\n# keep this comment\ntitle: Original\ntype: knowledge\nupdated: 2026-01-01\n---\n# Guide\nOriginal procedure.\n";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const file = () => path.join(storage.stashDir, "knowledge", "guide.md");

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  makeGitRepo({ dir: storage.stashDir });
  fs.writeFileSync(file(), RAW);
  git(storage.stashDir, ["add", "knowledge"]);
  git(storage.stashDir, ["commit", "-qm", "Original source"]);
  const url = "https://example.invalid/conditional-write.git";
  await writeLockfile([{ id: "stash", source: "git", ref: url, localRoot: storage.stashDir }]);
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    bundles: {
      stash: { git: url, writable: true, components: { main: { root: ".", adapter: "akm", writable: true } } },
    },
  });
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => storage.cleanup());

const options = (content: string) => ({
  type: "knowledge" as const,
  name: "guide",
  target: "stash",
  fallbackPrefix: "knowledge",
  force: true,
  content,
});

test("conditional no-op preserves exact bytes, mtime and Git history without normalizing missing metadata", async () => {
  const raw = RAW.replace("type: knowledge\n", "").replace("updated: 2026-01-01\n", "");
  fs.writeFileSync(file(), raw);
  const before = fs.statSync(file(), { bigint: true }).mtimeNs;
  const head = git(storage.stashDir, ["rev-parse", "HEAD"]);
  const result = await withAssetMutationLease("outer-ui-save", () =>
    writeMarkdownAsset({ ...options(raw), expectedContentHash: hash(raw) }),
  );
  expect(result.unchanged).toBe(true);
  expect(fs.readFileSync(file(), "utf8")).toBe(raw);
  expect(fs.statSync(file(), { bigint: true }).mtimeNs).toBe(before);
  expect(git(storage.stashDir, ["rev-parse", "HEAD"])).toBe(head);
});

test("only one concurrent writer can publish against the same source revision", async () => {
  const results = await Promise.allSettled([
    writeMarkdownAsset({
      ...options(RAW.replace("Original procedure", "First revision")),
      expectedContentHash: hash(RAW),
    }),
    writeMarkdownAsset({
      ...options(RAW.replace("Original procedure", "Second revision")),
      expectedContentHash: hash(RAW),
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason.code).toBe("ASSET_CONTENT_CHANGED");
  expect(git(storage.stashDir, ["rev-list", "--count", "HEAD"]).trim()).toBe("3");
});

test("stale or removed source rejects before write/commit, while a matching edit preserves source and indexes", async () => {
  const changed = RAW.replace("Original procedure", "Fresh quasarprocedure");
  const before = git(storage.stashDir, ["rev-parse", "HEAD"]);
  await expect(writeMarkdownAsset({ ...options(changed), expectedContentHash: "0".repeat(64) })).rejects.toMatchObject({
    code: "ASSET_CONTENT_CHANGED",
  });
  expect(fs.readFileSync(file(), "utf8")).toBe(RAW);
  expect(git(storage.stashDir, ["rev-parse", "HEAD"])).toBe(before);
  const saved = await writeMarkdownAsset({ ...options(changed), expectedContentHash: hash(RAW) });
  expect(saved.unchanged).toBeUndefined();
  expect(fs.readFileSync(file(), "utf8")).toBe(changed);
  expect(git(storage.stashDir, ["status", "--porcelain"])).toBe("");
  expect((await akmSearch({ query: "quasarprocedure", type: "knowledge", readOnly: true })).hits).toHaveLength(1);
  fs.unlinkSync(file());
  await expect(writeMarkdownAsset({ ...options(changed), expectedContentHash: hash(changed) })).rejects.toMatchObject({
    code: "ASSET_CONTENT_CHANGED",
  });
  expect(fs.existsSync(file())).toBe(false);
});

test("a held shared lease blocks the writer before any content mutation", async () => {
  const lease = await acquireAssetMutationLease({ purpose: "competing-write" });
  const pending = writeMarkdownAsset(options(RAW.replace("Original procedure", "After lease")));
  try {
    expect(fs.readFileSync(file(), "utf8")).toBe(RAW);
  } finally {
    lease!.release();
  }
  await pending;
  expect(fs.readFileSync(file(), "utf8")).toContain("After lease");
});

test("real import and remember CLI processes participate in the shared lease", async () => {
  const lease = await acquireAssetMutationLease({ purpose: "ui-save" });
  const run = (command: "import" | "remember") =>
    new Promise<{ error: unknown; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [
          path.resolve("src/cli.ts"),
          command,
          ...(command === "import" ? ["-"] : []),
          "--name=from-cli",
          "--bundle=stash",
          "--format=json",
        ],
        { encoding: "utf8", timeout: 10000 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
      child.stdin!.on("error", () => {});
      child.stdin!.end("# CLI source\nFrom the concurrent command.\n");
    });
  const pending = Promise.all([run("import"), run("remember")]);
  try {
    await Bun.sleep(500);
    expect(fs.existsSync(path.join(storage.stashDir, "knowledge", "from-cli.md"))).toBe(false);
    expect(fs.existsSync(path.join(storage.stashDir, "memories", "from-cli.md"))).toBe(false);
  } finally {
    lease!.release();
  }
  const results = await pending;
  for (const result of results) expect(result.error, result.stderr).toBeNull();
  for (const dir of ["knowledge", "memories"])
    expect(fs.readFileSync(path.join(storage.stashDir, dir, "from-cli.md"), "utf8")).toContain("concurrent command");
});
