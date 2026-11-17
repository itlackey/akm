// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: reads a real index in isolated storage.
/**
 * What akm accepts doing to each entry of a bundle listing and to a shown asset, and the sentence why not. Every
 * verdict is computed from the checks the operations run, so these compare a refusal with the operation's own.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { inspectWriteTarget } from "../../../src/core/write-source";
import { akmIndex } from "../../../src/indexer/indexer";
import { assets, documents } from "../../../src/workspace";
import type { FileActions } from "../../../src/workspace/file-actions";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let locked: string;
let claude: string;

function put(root: string, rel: string, content: string | Buffer): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

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

const entries = async (bundle: string, dir = "", hidden = false) =>
  Object.fromEntries(
    (
      (await assets.bundleFiles({ bundle, path: dir, hidden })) as {
        entries: Array<{ name: string; actions: FileActions }>;
      }
    ).entries.map((entry) => [entry.name, entry.actions]),
  );

const refusal = (actions: FileActions, action: keyof FileActions): string | undefined => {
  const verdict = actions[action];
  return verdict.allowed ? undefined : verdict.reason;
};

describe("a file of a writable akm bundle", () => {
  test("an indexed asset is read, edited, moved, copied and retired, never deleted", async () => {
    put(storage.stashDir, "knowledge/guide.md", "---\ndescription: Guide\n---\n\n# Guide\n");
    await akmIndex({ stashDir: storage.stashDir });

    const guide = (await entries("stash", "knowledge"))["guide.md"] as FileActions;

    expect(
      guide.read.allowed && guide.edit.allowed && guide.move.allowed && guide.copy.allowed && guide.retire.allowed,
    ).toBe(true);
    expect(refusal(guide, "delete")).toContain("retired, not deleted");
  });

  test("a plain text file is edited, moved, copied and deleted, and has nothing to retire", async () => {
    put(storage.stashDir, "knowledge/draft.txt", "plain notes\n");

    const draft = (await entries("stash", "knowledge"))["draft.txt"] as FileActions;

    expect(
      draft.read.allowed && draft.edit.allowed && draft.move.allowed && draft.copy.allowed && draft.delete.allowed,
    ).toBe(true);
    expect(refusal(draft, "retire")).toContain("not an indexed asset");
  });

  test("a file that is not text cannot be read or edited, but can be moved, copied and deleted", async () => {
    put(storage.stashDir, "knowledge/pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    put(storage.stashDir, "knowledge/latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]));

    const listed = await entries("stash", "knowledge");

    for (const name of ["pic.png", "latin1.txt"]) {
      const file = listed[name] as FileActions;
      expect(refusal(file, "read")).toBe("This is not a text file.");
      expect(refusal(file, "edit")).toBe("This is not a text file.");
      expect(file.move.allowed && file.copy.allowed && file.delete.allowed).toBe(true);
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "a file that cannot be opened says why, and is not read as binary or as text",
    async () => {
      put(storage.stashDir, "knowledge/locked.txt", "text\n");
      fs.chmodSync(path.join(storage.stashDir, "knowledge/locked.txt"), 0o000);
      try {
        const file = (await entries("stash", "knowledge"))["locked.txt"] as FileActions;

        for (const action of ["read", "edit", "copy"] as const)
          expect(refusal(file, action)).toMatch(/cannot be opened: .*EACCES/);
        expect(file.move.allowed && file.delete.allowed).toBe(true);
      } finally {
        fs.chmodSync(path.join(storage.stashDir, "knowledge/locked.txt"), 0o644);
      }
    },
  );

  test("a skill's manifest moves as its folder, and a skill is not retired", async () => {
    put(storage.stashDir, "skills/backup/SKILL.md", "---\ndescription: Backup\n---\n\n# Backup\n");
    put(storage.stashDir, "skills/backup/notes.txt", "notes\n");
    await akmIndex({ stashDir: storage.stashDir });

    const manifest = (await entries("stash", "skills/backup"))["SKILL.md"] as FileActions;
    const folder = (await entries("stash", "skills"))["backup"] as FileActions;

    expect(refusal(manifest, "move")).toBe("A skill moves as its folder.");
    expect(refusal(manifest, "retire")).toBe(
      "Retire supports single-file assets, not skill packages or protected files.",
    );
    expect(manifest.edit.allowed).toBe(true);
    expect(folder.move.allowed).toBe(true);
  });

  test("an empty folder is deleted, a folder with files is not, and a folder has no text or asset", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "knowledge", "empty"));
    put(storage.stashDir, "knowledge/full/a.txt", "a");

    const listed = await entries("stash", "knowledge");

    expect((listed.empty as FileActions).delete.allowed).toBe(true);
    expect(refusal(listed.full as FileActions, "delete")).toBe("The folder is not empty.");
    expect(refusal(listed.full as FileActions, "edit")).toBe("A folder has no text to open.");
    expect((listed.full as FileActions).move.allowed && (listed.full as FileActions).copy.allowed).toBe(true);
    expect(refusal(listed.full as FileActions, "retire")).toContain("folder");
  });

  test("the git and akm folders are managed by akm and refuse every action", async () => {
    put(storage.stashDir, ".git/config", "[core]\n");
    put(storage.stashDir, ".akm/state/x.json", "{}");

    const root = await entries("stash", "", true);
    const gitFiles = await entries("stash", ".git", true);

    for (const verdicts of [root[".git"], root[".akm"], gitFiles.config] as FileActions[])
      for (const action of ["read", "edit", "move", "copy", "retire", "delete"] as const)
        expect(refusal(verdicts, action)).toMatch(/is managed by akm/);
  });

  test("env and secret files stay in their own view, and listing never opens them", async () => {
    put(storage.stashDir, "env/prod.env", "A=1\n");
    put(storage.stashDir, "secrets/token", "synthetic");
    put(storage.stashDir, "knowledge/plain.txt", "plain\n");
    const open = spyOn(fs, "openSync");
    try {
      const env = (await entries("stash", "env"))["prod.env"] as FileActions;
      const secret = (await entries("stash", "secrets"))["token"] as FileActions;
      await entries("stash", "knowledge");
      for (const verdicts of [env, secret])
        for (const action of ["read", "edit", "move", "copy", "retire", "delete"] as const)
          expect(refusal(verdicts, action)).toContain("protected-file view");
      const opened = open.mock.calls.map((call) => String(call[0]));
      // The probe opens an ordinary file (the control) and never a protected one.
      expect(opened.some((file) => file.endsWith("plain.txt"))).toBe(true);
      expect(opened.some((file) => /[\\/](env|secrets)[\\/]/.test(file))).toBe(false);
    } finally {
      open.mockRestore();
    }
  });
});

describe("a bundle akm does not write", () => {
  test("a read-only bundle can be read and copied from, and every write says the write path's own sentence", async () => {
    put(locked, "knowledge/ref.md", "---\ndescription: Ref\n---\n\n# Ref\n");
    await akmIndex({ stashDir: storage.stashDir });

    const file = (await entries("locked", "knowledge"))["ref.md"] as FileActions;
    const blocker = inspectWriteTarget(loadConfig(), "locked").blocker;

    expect(blocker).toBeTruthy();
    expect(file.read.allowed && file.copy.allowed).toBe(true);
    for (const action of ["edit", "move", "retire", "delete"] as const)
      expect(refusal(file, action)).toBe(blocker as string);
  });

  test("a bundle of another adapter refuses akm's writes with the adapter sentence", async () => {
    put(claude, "agents/helper.md", "---\ndescription: Helper\n---\n\n# Helper\n");

    const file = (await entries("claude", "agents"))["helper.md"] as FileActions;

    expect(refusal(file, "edit")).toBe(
      'Bundle "claude" uses adapter "claude", which does not support AKM asset writes.',
    );
    expect(file.read.allowed && file.copy.allowed).toBe(true);
  });
});

describe("a shown asset", () => {
  test("carries the verdicts its file has in the listing", async () => {
    put(storage.stashDir, "knowledge/guide.md", "---\ndescription: Guide\n---\n\n# Guide\n");
    put(storage.stashDir, "skills/backup/SKILL.md", "---\ndescription: Backup\n---\n\n# Backup\n");
    await akmIndex({ stashDir: storage.stashDir });

    const shown = (await assets.show({ ref: "stash//knowledge/guide" })) as { actions: FileActions };
    const listed = (await entries("stash", "knowledge"))["guide.md"];

    expect(shown.actions).toEqual(listed as FileActions);
  });

  test("a refusal is the sentence the operation gives: a skill is not retired", async () => {
    put(storage.stashDir, "skills/backup/SKILL.md", "---\ndescription: Backup\n---\n\n# Backup\n");
    await akmIndex({ stashDir: storage.stashDir });
    const shown = (await assets.show({ ref: "stash//skills/backup" })) as { actions: FileActions };

    const reason = refusal(shown.actions, "retire");

    await expect(documents.retire({ ref: "stash//skills/backup", revision: "x" })).rejects.toThrow(reason as string);
  });
});
