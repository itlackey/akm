// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: reads and saves single-file assets of every editable type through a real index and git bundle.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { handleApiRequest } from "../../../src/commands/ui/api";
import { handleWorkspaceAction } from "../../../src/commands/ui/workspace-actions";
import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeLockfile } from "../../../src/integrations/lockfile";
import { git, makeGitRepo } from "../../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const file = (relative: string) => path.join(storage.stashDir, relative);
const source = (ref: string) =>
  handleApiRequest("/api/asset/source", new URLSearchParams({ ref })) as Promise<{
    ref: string;
    type: string;
    content: string;
    revision: string;
  }>;
const save = (ref: string, revision: string, content: string) =>
  handleWorkspaceAction("document-save", { ref, revision, content }) as Promise<{ unchanged?: true }>;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    registries: [],
  });
  resetConfigCache();
});
afterEach(() => storage.cleanup());

const FILES: Array<[string, string, string]> = [
  ["commands/deploy.md", "stash//commands/deploy", "---\ndescription: Deploy\n---\nRun the deploy.\n"],
  ["agents/helper.md", "stash//agents/helper", "---\ndescription: Helper\n---\nHelp out.\n"],
  [
    "lessons/rg.md",
    "stash//lessons/rg",
    "---\ndescription: Use rg\nwhen_to_use: Searching repos\n---\nPrefer rg over grep.\n",
  ],
  ["skills/example/SKILL.md", "stash//skills/example", "---\nname: example\ndescription: Example\n---\nSkill body.\n"],
  ["scripts/tool.sh", "stash//scripts/tool.sh", "#!/bin/sh\necho original\n"],
];

test("every single-file type reads and saves in place: mode kept, index refreshed, stale revision refused", async () => {
  for (const [relative, , body] of FILES) {
    fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
    fs.writeFileSync(file(relative), body, { mode: 0o750 });
  }
  fs.writeFileSync(file("memories/other.md"), "---\ndescription: other\n---\nOther.\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  for (const [relative, ref, body] of FILES) {
    const read = await source(ref);
    expect(read).toMatchObject({ ref, revision: sha(body) });
    const marker = `zirconmarker${path.basename(relative).replace(/\W/g, "")}`;
    const edited = relative.endsWith(".sh") ? `${read.content}echo ${marker}\n` : `${read.content}${marker}\n`;
    expect(await save(ref, read.revision, edited)).not.toHaveProperty("unchanged");
    const written = fs.readFileSync(file(relative), "utf8");
    expect(written).toContain(marker);
    expect(written).toContain(read.content.split("\n")[0]!);
    expect(fs.statSync(file(relative)).mode & 0o777).toBe(0o750);
    // Script bodies are not searchable text; the other types are found by what was just saved.
    if (relative.endsWith(".md"))
      expect(
        (await akmSearch({ query: marker, skipLogging: true })).hits.map((hit) => (hit as { ref?: string }).ref),
      ).toContain(ref.replace("stash//", ""));
    // The same revision is now stale, and nothing is written.
    await expect(save(ref, read.revision, `${edited}late\n`)).rejects.toMatchObject({ code: "ASSET_CONTENT_CHANGED" });
    expect(fs.readFileSync(file(relative), "utf8")).toBe(written);
    // An identical save is a no-op.
    const fresh = await source(ref);
    const mtime = fs.statSync(file(relative), { bigint: true }).mtimeNs;
    expect(await save(ref, fresh.revision, fresh.content)).toMatchObject({ unchanged: true });
    expect(fs.statSync(file(relative), { bigint: true }).mtimeNs).toBe(mtime);
  }
});

test("protected, generated, unindexed and non-UTF-8 files are refused and left alone", async () => {
  fs.mkdirSync(file("env"), { recursive: true });
  fs.mkdirSync(file("secrets"), { recursive: true });
  fs.writeFileSync(file("env/prod.env"), "TOKEN=planted\n");
  fs.writeFileSync(file("secrets/key"), "planted-secret");
  fs.mkdirSync(file("skills/example"), { recursive: true });
  fs.writeFileSync(file("skills/example/SKILL.md"), "---\nname: example\ndescription: Example\n---\nBody.\n");
  fs.writeFileSync(file("skills/example/notes.md"), "support file");
  const latin = Buffer.from([
    0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a, 0x65, 0x63, 0x68, 0x6f, 0x20, 0xe9,
  ]);
  fs.writeFileSync(file("scripts/latin.sh"), latin);
  fs.writeFileSync(file("scripts/new.sh"), "#!/bin/sh\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  fs.writeFileSync(file("scripts/unindexed.sh"), "#!/bin/sh\n");
  for (const [ref, message] of [
    ["stash//env/prod", "single-file"],
    ["stash//secrets/key", "single-file"],
    ["stash//skills/example/notes.md", "Stash asset not found"],
    ["stash//scripts/latin.sh", "not valid UTF-8"],
    ["stash//scripts/unindexed.sh", "Stash asset not found"],
  ] as const) {
    await expect(source(ref)).rejects.toThrow(message);
    await expect(save(ref, sha("x"), "replacement")).rejects.toThrow(message);
  }
  expect(fs.readFileSync(file("env/prod.env"), "utf8")).toBe("TOKEN=planted\n");
  expect(fs.readFileSync(file("secrets/key"), "utf8")).toBe("planted-secret");
  expect(fs.readFileSync(file("skills/example/notes.md"), "utf8")).toBe("support file");
  expect(fs.readFileSync(file("scripts/latin.sh")).equals(latin)).toBe(true);
});

test("a read-only bundle and a symbolic link to a file outside the bundle are refused", async () => {
  fs.writeFileSync(file("scripts/tool.sh"), "#!/bin/sh\necho original\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const read = await source("stash//scripts/tool.sh");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: false } },
    defaultBundle: "stash",
  });
  await expect(save(read.ref, read.revision, "#!/bin/sh\necho changed\n")).rejects.toThrow("not writable");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  });
  const outside = path.join(path.dirname(storage.stashDir), "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "linked.sh"), "#!/bin/sh\necho linked\n");
  fs.symlinkSync(path.join(outside, "linked.sh"), file("scripts/linked.sh"));
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const linked = "stash//scripts/linked.sh";
  await expect(save(linked, sha("#!/bin/sh\necho linked\n"), "#!/bin/sh\necho overwritten\n")).rejects.toThrow(
    /symbolic|outside/,
  );
  expect(fs.readFileSync(path.join(outside, "linked.sh"), "utf8")).toBe("#!/bin/sh\necho linked\n");
  expect(fs.readFileSync(file("scripts/tool.sh"), "utf8")).toBe("#!/bin/sh\necho original\n");
});

test("a git bundle commits only the saved file", async () => {
  fs.writeFileSync(file("scripts/tool.sh"), "#!/bin/sh\necho original\n");
  makeGitRepo({ dir: storage.stashDir });
  git(storage.stashDir, ["add", "scripts/tool.sh"]);
  git(storage.stashDir, ["commit", "-qm", "Original"]);
  fs.writeFileSync(file("unrelated.txt"), "unrelated staged work");
  git(storage.stashDir, ["add", "unrelated.txt"]);
  const url = "https://example.invalid/document-save.git";
  await writeLockfile([{ id: "stash", source: "git", ref: url, localRoot: storage.stashDir }]);
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: {
      stash: { git: url, writable: true, components: { main: { root: ".", adapter: "akm", writable: true } } },
    },
  });
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const read = await source("stash//scripts/tool.sh");
  await save(read.ref, read.revision, "#!/bin/sh\necho committed\n");
  expect(git(storage.stashDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim()).toBe(
    "scripts/tool.sh",
  );
  expect(git(storage.stashDir, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
});
