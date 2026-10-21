// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeMarkdownAsset } from "../../../src/commands/read/knowledge";
import { akmSearch } from "../../../src/commands/read/search";
import {
  acquireAssetMutationLease,
  probeAssetMutationLease,
  withAssetMutationLease,
} from "../../../src/indexer/index-writer-lock";
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

test("a submission that differs only by the final line break the writer adds is a no-op", async () => {
  const before = fs.statSync(file(), { bigint: true }).mtimeNs;
  const head = git(storage.stashDir, ["rev-parse", "HEAD"]);
  const result = await writeMarkdownAsset({ ...options(RAW.slice(0, -1)), expectedContentHash: hash(RAW) });
  expect(result.unchanged).toBe(true);
  expect(fs.readFileSync(file(), "utf8")).toBe(RAW);
  expect(fs.statSync(file(), { bigint: true }).mtimeNs).toBe(before);
  expect(git(storage.stashDir, ["rev-parse", "HEAD"])).toBe(head);
});

test("a malformed expected content hash is a usage error, not a changed document", async () => {
  for (const expectedContentHash of ["", "not-hex", "Z".repeat(64), hash(RAW).toUpperCase(), `${hash(RAW)}0`]) {
    await expect(
      writeMarkdownAsset({ ...options(RAW.replace("Original procedure", "Edited")), expectedContentHash }),
    ).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
  }
  expect(fs.readFileSync(file(), "utf8")).toBe(RAW);
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
  let settled = false;
  const pending = writeMarkdownAsset(options(RAW.replace("Original procedure", "After lease"))).finally(() => {
    settled = true;
  });
  try {
    // Yield to the event loop across several of the writer's 100ms lease
    // polls; without the lease the write would land in this time.
    await Bun.sleep(350);
    expect(settled).toBe(false);
    const probe = probeAssetMutationLease();
    expect(probe.state === "held" ? probe.rawContent : "").toContain("competing-write");
    expect(fs.readFileSync(file(), "utf8")).toBe(RAW);
  } finally {
    lease!.release();
  }
  await pending;
  expect(fs.readFileSync(file(), "utf8")).toContain("After lease");
});

test("real import and remember CLI processes participate in the shared lease", async () => {
  const lease = await acquireAssetMutationLease({ purpose: "ui-save" });
  const run = (command: "import" | "remember") => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("src/cli.ts"),
        command,
        ...(command === "import" ? ["-"] : []),
        "--name=from-cli",
        "--bundle=stash",
        "--format=json",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    let exited = false;
    child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.stdin.end("# CLI source\nFrom the concurrent command.\n");
    const done = new Promise<{ code: number | null; stderr: string }>((resolve) =>
      child.on("close", (code) => {
        exited = true;
        resolve({ code, stderr });
      }),
    );
    return { child, done, stderr: () => stderr, exited: () => exited };
  };
  const children = [run("import"), run("remember")];
  try {
    // Deterministic signal: each child has reached the lease and announced who
    // it is waiting for (the first notice comes after 15s of waiting).
    const deadline = Date.now() + 60_000;
    while (!children.every((child) => child.stderr().includes("waiting for ui-save"))) {
      const exited = children.find((child) => child.exited());
      if (exited) throw new Error(`a CLI child exited before waiting on the lease: ${exited.stderr()}`);
      if (Date.now() > deadline) throw new Error("timed out waiting for the CLI children's lease notices");
      await Bun.sleep(100);
    }
    expect(fs.existsSync(path.join(storage.stashDir, "knowledge", "from-cli.md"))).toBe(false);
    expect(fs.existsSync(path.join(storage.stashDir, "memories", "from-cli.md"))).toBe(false);
  } catch (error) {
    for (const child of children) child.child.kill();
    throw error;
  } finally {
    lease!.release();
  }
  const results = await Promise.all(children.map((child) => child.done));
  for (const result of results) expect(result.code, result.stderr).toBe(0);
  for (const dir of ["knowledge", "memories"])
    expect(fs.readFileSync(path.join(storage.stashDir, dir, "from-cli.md"), "utf8")).toContain("concurrent command");
}, 120_000);
