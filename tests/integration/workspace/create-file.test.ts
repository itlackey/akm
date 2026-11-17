// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: writes into real bundles and builds a real index in isolated storage.
/**
 * A new file in a folder of a bundle, for any type: the folder's type decides the starting text, the same checks apply
 * to every type, and a folder with no type gets an empty file of the name given.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { inspectWriteTarget } from "../../../src/core/write-source";
import { assets, documents } from "../../../src/workspace";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let locked: string;
let claude: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  locked = path.join(storage.root, "locked");
  claude = path.join(storage.root, "claude");
  fs.mkdirSync(locked, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  writeSandboxConfig({
    ...makeConfig(storage.stashDir),
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
      locked: { path: locked, writable: false, components: { main: { root: ".", adapter: "akm" } } },
      claude: { path: claude, writable: true, components: { main: { root: ".", adapter: "claude" } } },
    },
  });
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const read = (rel: string) => fs.readFileSync(path.join(storage.stashDir, rel), "utf8");
const create = (folder: string, name: string, bundle = "stash", content?: string) =>
  documents.createFile({ bundle, folder, name, ...(content === undefined ? {} : { content }) });
const message = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};
const code = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error("expected a refusal");
};

describe("the folder's type decides the file", () => {
  test("a lesson starts with the keys a lesson requires, and akm stamps the type and the date", async () => {
    const made = await create("lessons", "careful-restores");

    expect(made).toMatchObject({ bundle: "stash", file: "lessons/careful-restores.md", type: "lesson" });
    expect(read("lessons/careful-restores.md")).toMatch(
      /^---\ndescription: ""\nwhen_to_use: ""\ntype: lesson\nupdated: \d{4}-\d{2}-\d{2}\n---\n\n# Careful Restores\n$/,
    );
    expect(made.ref).toBe("stash//lessons/careful-restores");
  });

  test("a workflow starts with the workflow template and is indexed, a task with a valid task", async () => {
    const workflow = await create("workflows", "release");
    const task = await create("tasks", "nightly");

    expect(workflow).toMatchObject({ file: "workflows/release.md", type: "workflow", indexed: true });
    expect(read("workflows/release.md")).toContain("# Release");
    expect(task).toMatchObject({ file: "tasks/nightly.yml", type: "task" });
    expect(read("tasks/nightly.yml")).toContain("version: 4");
    expect(((await assets.show({ ref: workflow.ref as string })) as { redacted: boolean }).redacted).toBe(false);
    expect(task.ref).toBe("stash//tasks/nightly");
  });

  test("a command and an agent start with their name, a script with nothing", async () => {
    await create("commands", "deploy");
    await create("agents", "helper");
    const script = await create("scripts", "backup");

    expect(read("commands/deploy.md")).toContain("name: deploy\n");
    expect(read("agents/helper.md")).toContain("name: helper\n");
    expect(script).toMatchObject({ file: "scripts/backup.sh", type: "script" });
    expect(read("scripts/backup.sh")).toBe("");
  });

  test("knowledge goes into a nested folder it names", async () => {
    const made = await create("knowledge/ops/runbooks", "restore");

    expect(made).toMatchObject({ file: "knowledge/ops/runbooks/restore.md", type: "knowledge" });
    expect(read("knowledge/ops/runbooks/restore.md")).toContain("# Restore");
  });

  test("a folder with no type gets an empty file of the name given", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "reports"));

    const note = await create("reports", "notes.txt");
    const bare = await create("reports", "q3");

    expect(note).toMatchObject({ file: "reports/notes.txt", type: null });
    expect(read("reports/notes.txt")).toBe("");
    expect(bare.file).toBe("reports/q3");
    expect(read("reports/q3")).toBe("");
  });

  test("a skill is made as a SKILL.md in its folder, not as a file in skills/", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "skills/backup"), { recursive: true });

    const made = await create("skills/backup", "SKILL.md");

    expect(made).toMatchObject({ file: "skills/backup/SKILL.md", type: "skill" });
    expect(await message(create("skills", "backup"))).toBe(
      "A skill is a folder with a SKILL.md: create the folder first.",
    );
    expect(fs.existsSync(path.join(storage.stashDir, "skills/backup.md"))).toBe(false);
  });

  test("the text given replaces the starting text, and createKnowledge is this operation for knowledge", async () => {
    const given = await create(
      "lessons",
      "given",
      "stash",
      "---\ndescription: Given\nwhen_to_use: Always\n---\n\nBody.\n",
    );
    const knowledge = await documents.createKnowledge({
      bundle: "stash",
      name: "viaknowledge",
      path: "a/b",
      content: "# K\n",
    });

    expect(read("lessons/given.md")).toContain("description: Given");
    expect(knowledge).toMatchObject({
      file: "knowledge/a/b/viaknowledge.md",
      type: "knowledge",
      ref: "stash//knowledge/a/b/viaknowledge",
    });
    expect(given.type).toBe("lesson");
  });
});

describe("the same checks apply to every type", () => {
  test("an existing file is refused and left as it is", async () => {
    await create("lessons", "once");
    const before = read("lessons/once.md");

    expect(await code(create("lessons", "once"))).toBe("RESOURCE_ALREADY_EXISTS");
    expect(await code(create("lessons", "once.md"))).toBe("RESOURCE_ALREADY_EXISTS");
    expect(read("lessons/once.md")).toBe(before);
  });

  test("malformed frontmatter is refused for a lesson as it is for knowledge", async () => {
    expect(await message(create("lessons", "bad", "stash", "---\ntitle: [oops\n---\n\nBody.\n"))).toBe(
      "AKM Markdown has malformed YAML frontmatter.",
    );
    expect(await message(create("knowledge", "bad", "stash", "---\ntitle: [oops\n---\n\nBody.\n"))).toBe(
      "AKM Markdown has malformed YAML frontmatter.",
    );
    expect(fs.existsSync(path.join(storage.stashDir, "lessons/bad.md"))).toBe(false);
  });

  test("a name with a slash, and a folder or name that leaves the bundle, are refused", async () => {
    await expect(create("lessons", "a/b")).rejects.toThrow("flat name");
    await expect(create("../outside", "x")).rejects.toThrow("relative directory");
    await expect(create("lessons", "..")).rejects.toThrow("not a file name");
    expect(fs.existsSync(path.join(storage.root, "outside"))).toBe(false);
  });

  test("a bundle that is read-only, or of another adapter, is refused with its sentence", async () => {
    expect(await message(create("lessons", "x", "locked"))).toContain("Bundle locked is read-only");
    expect(await message(create("agents", "x", "claude"))).toContain("does not support AKM asset writes");
    expect(await message(create("lessons", "x", "missing"))).toContain("not configured");
  });

  test("env, secrets and the folders akm manages are not places for a new file", async () => {
    for (const folder of ["env", "secrets", "projects/x/env", ".git", ".akm/state"])
      expect(await message(create(folder, "x"))).toMatch(/protected-file view|managed by akm/);
    expect(fs.existsSync(path.join(storage.stashDir, ".git"))).toBe(false);
  });
});

describe("a listing says what a new file in its folder would be", () => {
  const verdict = async (bundle: string, folder: string) =>
    (
      (await assets.bundleFiles({ bundle, path: folder, hidden: true })) as {
        newFile: { allowed: boolean; type: string | null; reason?: string };
      }
    ).newFile;

  test("the type of the folder, none for a loose folder, and why not for a place akm refuses", async () => {
    for (const folder of ["reports", ".git", "workflows", "tasks", "env", "secrets"])
      fs.mkdirSync(path.join(storage.stashDir, folder));
    fs.mkdirSync(path.join(storage.stashDir, "skills"), { recursive: true });
    fs.mkdirSync(path.join(storage.stashDir, "skills/backup"), { recursive: true });

    expect(await verdict("stash", "lessons")).toEqual({ allowed: true, type: "lesson" });
    expect(await verdict("stash", "workflows")).toEqual({ allowed: true, type: "workflow" });
    expect(await verdict("stash", "tasks")).toEqual({ allowed: true, type: "task" });
    expect(await verdict("stash", "scripts")).toEqual({ allowed: true, type: "script" });
    expect(await verdict("stash", "reports")).toEqual({ allowed: true, type: null });
    expect(await verdict("stash", "skills/backup")).toEqual({ allowed: true, type: null });
    expect(await verdict("stash", "skills")).toMatchObject({ allowed: false, type: "skill" });
    expect(await verdict("stash", "env")).toEqual({ allowed: true, type: "env", through: "protected-editor" });
    expect(await verdict("stash", "secrets")).toEqual({ allowed: true, type: "secret", through: "protected-editor" });
    expect(await verdict("stash", ".git")).toMatchObject({ allowed: false, reason: ".git/ is managed by akm." });
    fs.mkdirSync(path.join(locked, "env"));
    expect(await verdict("locked", "env")).toMatchObject({ allowed: false, type: "env" });
    expect(await verdict("locked", "")).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("read-only"),
    });
  });

  test("a folder or a moved entry may go where no file of a type may, and nowhere akm refuses", async () => {
    for (const folder of ["env", ".git"]) fs.mkdirSync(path.join(storage.stashDir, folder));
    fs.mkdirSync(path.join(storage.stashDir, "skills"), { recursive: true });
    const place = async (bundle: string, folder: string) =>
      ((await assets.bundleFiles({ bundle, path: folder, hidden: true })) as { place: { allowed: boolean } }).place;

    expect(await place("stash", "skills")).toEqual({ allowed: true });
    expect(await place("stash", "")).toEqual({ allowed: true });
    expect(await place("stash", "env")).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") });
    expect(await place("stash", ".git")).toMatchObject({ allowed: false, reason: ".git/ is managed by akm." });
    expect(await place("locked", "")).toMatchObject({ allowed: false, reason: expect.stringContaining("read-only") });
  });
});
