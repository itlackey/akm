// Integration: exercises real index, filesystem archives, and Git publication.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { purgeGracedArchive } from "../../../src/commands/improve/memory/memory-improve";
import { createProposal, listProposals } from "../../../src/commands/proposal/repository";
import { akmSearch } from "../../../src/commands/read/search";
import { handleApiRequest } from "../../../src/commands/ui/api";
import { restoreRetiredAssets, retireAsset } from "../../../src/commands/ui/asset-retirement";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeLockfile } from "../../../src/integrations/lockfile";
import { git, makeGitRepo } from "../../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const ref = "stash//memories/manual";
const body = "---\ndescription: quartz note\nbeliefState: deprecated\n---\nOriginal quartz text.\r\n";
const hash = () => createHash("sha256").update(body).digest("hex");
const file = () => path.join(storage.stashDir, "memories/manual.md");
beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    registries: [],
  });
  fs.writeFileSync(file(), body, { mode: 0o640 });
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => storage.cleanup());

test("direct archive and Undo retain bytes, modes, belief state and leave proposals unchanged", async () => {
  const pending = createProposal(storage.stashDir, {
    ref,
    source: "reflect",
    payload: { content: `${body}Proposed change.` },
  });
  const before = listProposals(storage.stashDir);
  const receipt = await retireAsset(ref, hash());
  expect(receipt.complete).toBe(true);
  expect(fs.existsSync(file())).toBe(false);
  expect(listProposals(storage.stashDir)).toEqual(before);
  expect(before.map((row) => row.id)).toContain(pending.id);
  const archive = path.join(receipt.root, receipt.archived[0]!.archivedPath);
  expect(fs.readFileSync(archive, "utf8")).toBe(body);
  const tombstone = parseFrontmatter(
    fs.readFileSync(path.join(receipt.root, receipt.archived[0]!.auditPath), "utf8"),
  ).data;
  expect(tombstone.previousBeliefState).toBe("deprecated");
  expect(tombstone.proposalId).toBeUndefined();
  expect(tombstone.retiredAt).toBeUndefined();
  expect((await akmSearch({ query: "quartz", skipLogging: true })).hits).toHaveLength(0);
  const restored = await restoreRetiredAssets(
    receipt.bundle,
    receipt.archived.map((item) => item.auditPath),
  );
  expect(restored.complete).toBe(true);
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(fs.statSync(file()).mode & 0o777).toBe(0o640);
  fs.appendFileSync(file(), "New work");
  expect(fs.readFileSync(archive, "utf8")).toBe(body);
  await expect(
    restoreRetiredAssets(
      receipt.bundle,
      receipt.archived.map((item) => item.auditPath),
    ),
  ).rejects.toThrow("occupied");
});

test("memory retirement and Undo carry its derived twin without a proposal", async () => {
  const twin = file().replace(".md", ".derived.md");
  fs.writeFileSync(twin, "---\ndescription: quartz derived\n---\nDerived quartz text.\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const receipt = await retireAsset(ref, hash());
  expect(receipt.archived).toHaveLength(2);
  expect(fs.existsSync(twin)).toBe(false);
  expect(listProposals(storage.stashDir)).toHaveLength(0);
  expect((await akmSearch({ query: "quartz", skipLogging: true })).hits).toHaveLength(0);
  await restoreRetiredAssets(
    receipt.bundle,
    receipt.archived.map((item) => item.auditPath),
  );
  expect(fs.existsSync(twin)).toBe(true);
});

test("stale content and archive symlink are refused without changing the active file", async () => {
  await expect(retireAsset(ref, "stale")).rejects.toThrow("changed");
  const outside = path.join(path.dirname(storage.stashDir), "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(storage.stashDir, ".akm/memory-cleanup"), { recursive: true });
  fs.symlinkSync(outside, path.join(storage.stashDir, ".akm/memory-cleanup/archive"));
  await expect(retireAsset(ref, hash())).rejects.toThrow(/symbolic|escapes/);
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(listProposals(storage.stashDir)).toHaveLength(0);
});

test("a derived directory or symlink is refused before moving either asset", async () => {
  const twin = file().replace(".md", ".derived.md");
  fs.mkdirSync(twin);
  await expect(retireAsset(ref, hash())).rejects.toThrow("regular");
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  fs.rmdirSync(twin);
  fs.symlinkSync(file(), twin);
  await expect(retireAsset(ref, hash())).rejects.toThrow("symbolic");
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
});

test("partial archival leaves a usable receipt and the untouched twin", async () => {
  const twin = file().replace(".md", ".derived.md");
  fs.writeFileSync(twin, "Derived bytes");
  const rename = fs.renameSync;
  const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (from === twin) throw new Error("synthetic twin archive failure");
    return rename(from, to);
  });
  const receipt = await retireAsset(ref, hash());
  failure.mockRestore();
  expect(receipt.complete).toBe(false);
  expect(receipt.archived).toHaveLength(1);
  expect(receipt.warnings.join(" ")).toContain("synthetic twin archive failure");
  expect(fs.readFileSync(twin, "utf8")).toBe("Derived bytes");
  await restoreRetiredAssets(
    receipt.bundle,
    receipt.archived.map((item) => item.auditPath),
  );
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
});

test("restore validates every tombstone before writing and never overwrites an occupied path", async () => {
  const receipt = await retireAsset(ref, hash());
  const audit = receipt.archived[0]!.auditPath;
  await expect(restoreRetiredAssets(receipt.bundle, [audit, "../../outside/cleanup.md"])).rejects.toThrow("escapes");
  expect(fs.existsSync(file())).toBe(false);
  const archived = path.join(receipt.root, receipt.archived[0]!.archivedPath);
  fs.renameSync(archived, `${archived}.moved`);
  await expect(restoreRetiredAssets(receipt.bundle, [audit])).rejects.toThrow("archived file is missing");
  fs.renameSync(`${archived}.moved`, archived);
  fs.symlinkSync(path.join(storage.stashDir, "missing"), file());
  await expect(restoreRetiredAssets(receipt.bundle, [audit])).rejects.toThrow("symbolic");
  expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
});

test("partial restore reports the copied file and retains every recovery copy", async () => {
  const twin = file().replace(".md", ".derived.md");
  fs.writeFileSync(twin, "Derived bytes");
  const receipt = await retireAsset(ref, hash());
  const copy = fs.copyFileSync;
  const failure = spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
    if (to === twin) throw new Error("synthetic restore failure");
    return copy(from, to, mode);
  });
  const result = await restoreRetiredAssets(
    receipt.bundle,
    receipt.archived.map((item) => item.auditPath),
  );
  failure.mockRestore();
  expect(result.complete).toBe(false);
  expect(result.restored).toEqual([file()]);
  expect(result.warnings.join(" ")).toContain("synthetic restore failure");
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  for (const record of receipt.archived) expect(fs.existsSync(path.join(receipt.root, record.archivedPath))).toBe(true);
  await restoreRetiredAssets(receipt.bundle, [receipt.archived[1]!.auditPath]);
  expect(fs.readFileSync(twin, "utf8")).toBe("Derived bytes");
});

test("read-only bundles and skill packages cannot be retired", async () => {
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: false } },
    defaultBundle: "stash",
  });
  await expect(retireAsset(ref, hash())).rejects.toThrow("not writable");
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  });
  const skill = path.join(storage.stashDir, "skills/example/SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: example\ndescription: test skill\n---\nSkill content");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  await expect(retireAsset("stash//skills/example", hash())).rejects.toThrow("single-file");
  expect(fs.existsSync(skill)).toBe(true);
});

test("a newly marked nested secret remains protected without reindexing", async () => {
  const secret = path.join(storage.stashDir, "projects/demo/secrets/token.md");
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, "planted-private-secret");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  fs.writeFileSync(`${secret}.sensitive`, "");
  // The ref the index really assigns, with the file's real revision, so only the protection can refuse it.
  const secretRef = "stash//secrets/projects/demo/secrets/token.md";
  const revision = createHash("sha256").update("planted-private-secret").digest("hex");
  await expect(retireAsset(secretRef, revision)).rejects.toThrow("Choose an indexed local asset");
  expect(await handleApiRequest("/api/asset", new URLSearchParams({ ref: secretRef }))).toMatchObject({
    redacted: true,
  });
  expect(fs.readFileSync(secret, "utf8")).toBe("planted-private-secret");
  expect(fs.existsSync(path.join(storage.stashDir, ".akm/memory-cleanup/archive"))).toBe(false);
});

test("Git retirement commits only its paths and manual bytes survive the grace purge", async () => {
  makeGitRepo({ dir: storage.stashDir });
  git(storage.stashDir, ["add", "memories/manual.md"]);
  git(storage.stashDir, ["commit", "-qm", "Original note"]);
  const unrelated = path.join(storage.stashDir, "unrelated.txt");
  fs.writeFileSync(unrelated, "unrelated staged work");
  git(storage.stashDir, ["add", "unrelated.txt"]);
  const url = "https://example.invalid/manual-retirement.git";
  await writeLockfile([{ id: "stash", source: "git", ref: url, localRoot: storage.stashDir }]);
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: {
      stash: { git: url, writable: true, components: { main: { root: ".", adapter: "akm", writable: true } } },
    },
  });
  const receipt = await retireAsset(ref, hash());
  expect(receipt.complete).toBe(true);
  const committed = git(storage.stashDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
    .trim()
    .split("\n");
  expect(committed.sort()).toEqual(
    ["memories/manual.md", receipt.archived[0]!.auditPath, receipt.archived[0]!.archivedPath].sort(),
  );
  expect(git(storage.stashDir, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
  expect(purgeGracedArchive(storage.stashDir, new Date("2100-01-01"))).toEqual({ purgedDirs: 0, purgedFiles: 0 });
  expect(fs.readFileSync(path.join(receipt.root, receipt.archived[0]!.archivedPath), "utf8")).toBe(body);
  await restoreRetiredAssets(
    receipt.bundle,
    receipt.archived.map((item) => item.auditPath),
  );
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(git(storage.stashDir, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
});
