// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: copies between real bundles and builds a real index in isolated storage.
/** `assets.copyEntry`: a copy to a chosen folder, staged, indexed, with the origin of an asset in its `sources`. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { assets } from "../../../src/workspace";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let other: string;
let locked: string;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  other = path.join(storage.root, "other");
  locked = path.join(storage.root, "locked");
  for (const dir of [other, locked]) fs.mkdirSync(dir, { recursive: true });
  writeSandboxConfig({
    ...makeConfig(storage.stashDir),
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true, adapter: "akm" },
      other: { path: other, writable: true, adapter: "akm" },
      locked: { path: locked, writable: false, adapter: "akm" },
    },
  });
  resetConfigCache();
  const put = (rel: string, content: string) => {
    const file = path.join(storage.stashDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  put("knowledge/guide.md", "---\ndescription: A guide\nupdated: 2026-11-01\n---\n\n# Guide\n");
  put("notes/todo.txt", "one\n");
  put("skills/backup/SKILL.md", "---\nname: backup\ndescription: Back up\n---\n# Backup\n");
  put("skills/backup/references/list.md", "# List\n");
  fs.symlinkSync(path.join(storage.stashDir, "notes/todo.txt"), path.join(storage.stashDir, "skills/backup/link.txt"));
  put("env/prod.env", "TOKEN=x\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const copy = (from: string, folder: string, name: string, toBundle?: string) =>
  assets.copyEntry({ bundle: "stash", from, folder, name, ...(toBundle ? { toBundle } : {}) });
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected a refusal");
};

test("an asset is copied to the folder chosen, as a new file that records where it came from", async () => {
  const done = await copy("knowledge/guide.md", "archive/2026", "guide-copy.md");

  expect(done).toMatchObject({ to: "archive/2026/guide-copy.md", indexed: true });
  const text = fs.readFileSync(path.join(storage.stashDir, "archive/2026/guide-copy.md"), "utf8");
  expect(text).toContain("sources:");
  expect(text).toContain("stash//knowledge/guide");
  expect(fs.readFileSync(path.join(storage.stashDir, "knowledge/guide.md"), "utf8")).not.toContain("sources:");
});

test("a file that is no asset is copied as it is, and a folder with its links copied by content", async () => {
  await copy("notes/todo.txt", "notes", "todo-2.txt");
  expect(fs.readFileSync(path.join(storage.stashDir, "notes/todo-2.txt"), "utf8")).toBe("one\n");

  await copy("skills/backup", "skills", "backup-2");
  const copied = path.join(storage.stashDir, "skills/backup-2");
  expect(fs.readFileSync(path.join(copied, "references/list.md"), "utf8")).toBe("# List\n");
  expect(fs.lstatSync(path.join(copied, "link.txt")).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(path.join(copied, "SKILL.md"), "utf8")).toContain("stash//skills/backup");
  expect(fs.readdirSync(path.join(storage.stashDir, "skills")).filter((name) => name.includes(".tmp-"))).toEqual([]);
});

test("a copy goes to another bundle, and nothing is overwritten, protected or put in a bundle akm does not write", async () => {
  expect(await copy("knowledge/guide.md", "knowledge", "guide.md", "other")).toMatchObject({ toBundle: "other" });
  expect(fs.existsSync(path.join(other, "knowledge/guide.md"))).toBe(true);

  expect((await refusal(copy("knowledge/guide.md", "knowledge", "guide.md", "other"))).code).toBe(
    "RESOURCE_ALREADY_EXISTS",
  );
  expect((await refusal(copy("env/prod.env", "notes", "prod.env"))).message).toMatch(/not copied/);
  expect((await refusal(copy("knowledge/guide.md", "env", "x.md"))).message).toMatch(/protected-file view/);
  expect((await refusal(copy("knowledge/guide.md", "", "g.md", "locked"))).message).toMatch(/read-only/);
  expect(fs.existsSync(path.join(locked, "g.md"))).toBe(false);
});

test("copying a skill's manifest copies the skill's folder whole, and the verdict says so", async () => {
  fs.mkdirSync(path.join(storage.stashDir, "skills/backup/scripts"), { recursive: true });
  const script = path.join(storage.stashDir, "skills/backup/scripts/run.sh");
  fs.writeFileSync(script, "#!/bin/sh\n");
  fs.chmodSync(script, 0o755);
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const listing = assets.bundleFiles({ bundle: "stash", path: "skills/backup" }) as {
    entries: Array<{ name: string; actions: { copy: { allowed: boolean; as?: string } } }>;
  };
  expect(listing.entries.find((entry) => entry.name === "SKILL.md")?.actions.copy).toEqual({
    allowed: true,
    as: "skills/backup",
  });

  const done = await copy("skills/backup/SKILL.md", "skills", "backup-3");

  expect(done.to).toBe("skills/backup-3");
  const copied = path.join(storage.stashDir, "skills/backup-3");
  expect(fs.readFileSync(path.join(copied, "references/list.md"), "utf8")).toBe("# List\n");
  expect(fs.statSync(path.join(copied, "scripts/run.sh")).mode & 0o777).toBe(0o755);
  expect(fs.readFileSync(path.join(copied, "SKILL.md"), "utf8")).toContain("stash//skills/backup");
  expect(fs.existsSync(path.join(storage.stashDir, "skills/backup-3/SKILL.md"))).toBe(true);
  expect((await refusal(copy("skills/backup/SKILL.md", "skills", "backup-3"))).code).toBe("RESOURCE_ALREADY_EXISTS");
  expect(fs.readdirSync(copied).sort()).toEqual(["SKILL.md", "link.txt", "references", "scripts"]);
});
