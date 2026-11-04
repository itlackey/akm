// Integration: exercises real index, filesystem archives, and Git publication.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { purgeGracedArchive } from "../../../src/commands/improve/memory/memory-improve";
import { akmProposalAccept, akmProposalRevert } from "../../../src/commands/proposal/proposal";
import { createProposal, getProposal, listProposals } from "../../../src/commands/proposal/repository";
import { akmSearch } from "../../../src/commands/read/search";
import { handleApiRequest } from "../../../src/commands/ui/api";
import { retireAsset } from "../../../src/commands/ui/manual-retire";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import { renameBundle } from "../../../src/core/bundle-rename";
import { saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { writeLockfile } from "../../../src/integrations/lockfile";
import type { SchedulerBackend } from "../../../src/tasks/backends/types";
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
  // Writes into an empty index are skipped, so keep one other asset indexed.
  fs.writeFileSync(path.join(storage.stashDir, "memories/other.md"), "---\ndescription: other\n---\nOther.\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => storage.cleanup());

const archived = (receipt: Awaited<ReturnType<typeof retireAsset>>) =>
  receipt.archiveDirs.map((dir) => path.join(storage.stashDir, dir));
const tombstone = (dir: string) => parseFrontmatter(fs.readFileSync(path.join(dir, "cleanup.md"), "utf8")).data;
const revert = (receipt: Awaited<ReturnType<typeof retireAsset>>) => akmProposalRevert({ id: receipt.proposalId });

test("retire is an accepted retire proposal; revert restores bytes, mode and belief state and removes the archive", async () => {
  const pending = createProposal(storage.stashDir, {
    ref,
    source: "reflect",
    payload: { content: `${body}Proposed change.` },
  });
  const receipt = await retireAsset(ref, hash());
  expect(fs.existsSync(file())).toBe(false);
  const row = getProposal(storage.stashDir, receipt.proposalId);
  expect(row).toMatchObject({ status: "accepted", source: "propose", ref });
  expect(row.retirement).toBeUndefined();
  expect(row.retiredArchive?.dirs).toEqual(receipt.archiveDirs);
  expect(getProposal(storage.stashDir, pending.id).status).toBe("pending");
  const [dir] = archived(receipt);
  expect(fs.readFileSync(path.join(dir!, "memories/manual.md"), "utf8")).toBe(body);
  const data = tombstone(dir!);
  expect(data).toMatchObject({ reason: "manual", previousBeliefState: "deprecated", proposalId: receipt.proposalId });
  expect(typeof data.retiredAt).toBe("string");
  expect((await akmSearch({ query: "quartz", skipLogging: true })).hits).toHaveLength(0);

  expect((await revert(receipt)).proposal.status).toBe("reverted");
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(fs.statSync(file()).mode & 0o777).toBe(0o640);
  expect(fs.existsSync(dir!)).toBe(false);
  expect(await handleApiRequest("/api/asset", new URLSearchParams({ ref }))).toMatchObject({ durableRef: ref });
});

test("memory retirement and revert carry its derived twin", async () => {
  const twin = file().replace(".md", ".derived.md");
  fs.writeFileSync(twin, "---\ndescription: quartz derived\n---\nDerived quartz text.\n");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const receipt = await retireAsset(ref, hash());
  expect(receipt.archiveDirs).toHaveLength(2);
  expect(fs.existsSync(twin)).toBe(false);
  expect((await akmSearch({ query: "quartz", skipLogging: true })).hits).toHaveLength(0);
  await revert(receipt);
  expect(fs.existsSync(twin)).toBe(true);
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
});

test("a non-UTF-8 asset round-trips byte-exact through retire and revert", async () => {
  const script = path.join(storage.stashDir, "scripts/latin.sh");
  const bytes = Buffer.from([
    0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a, 0x65, 0x63, 0x68, 0x6f, 0x20, 0xe9, 0x0a,
  ]);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, bytes);
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const receipt = await retireAsset("stash//scripts/latin.sh", createHash("sha256").update(bytes).digest("hex"));
  expect(fs.existsSync(script)).toBe(false);
  await revert(receipt);
  expect(fs.readFileSync(script).equals(bytes)).toBe(true);
});

test("revert refuses to overwrite newer work at the original path", async () => {
  const receipt = await retireAsset(ref, hash());
  const [dir] = archived(receipt);
  fs.writeFileSync(file(), "New work");
  await expect(revert(receipt)).rejects.toThrow("already exists");
  expect(fs.readFileSync(file(), "utf8")).toBe("New work");
  expect(fs.existsSync(dir!)).toBe(true);
});

const noTasks: SchedulerBackend = {
  name: "cron",
  list: () => [],
  install: () => {
    throw new Error("No task installation expected");
  },
  uninstall: () => {
    throw new Error("No task removal expected");
  },
  setEnabled: () => {
    throw new Error("No task toggle expected");
  },
};
const rename = () =>
  renameBundle("stash", "renamed", {}, { backend: noTasks, syncTasks: async () => ({ ok: true }) as never });

test("revert still works after the bundle is renamed, for a manual retirement and for an ordinary proposal", async () => {
  const receipt = await retireAsset(ref, hash());
  const edit = createProposal(storage.stashDir, {
    ref: "stash//memories/other",
    source: "reflect",
    payload: { content: "---\ndescription: other\n---\nOther, revised.\n" },
  });
  await akmProposalAccept({ stashDir: storage.stashDir, id: edit.id });
  expect((await rename()).applied).toBe(true);
  expect(getProposal(storage.stashDir, receipt.proposalId).acceptedTarget?.source).toBe("renamed");
  expect((await revert(receipt)).proposal.status).toBe("reverted");
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect((await akmProposalRevert({ id: edit.id })).proposal.status).toBe("reverted");
  expect(fs.readFileSync(path.join(storage.stashDir, "memories/other.md"), "utf8")).toContain("Other.");
  expect(await handleApiRequest("/api/asset", new URLSearchParams({ ref: "renamed//memories/manual" }))).toMatchObject({
    durableRef: "renamed//memories/manual",
  });
});

test("an archive directory that is a symbolic link is refused before anything moves", async () => {
  const outside = path.join(path.dirname(storage.stashDir), "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(storage.stashDir, ".akm/memory-cleanup"), { recursive: true });
  fs.symlinkSync(outside, path.join(storage.stashDir, ".akm/memory-cleanup/archive"));
  await expect(retireAsset(ref, hash())).rejects.toThrow(/symbolic/);
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(listProposals(storage.stashDir, { includeArchive: true })[0]?.status).toBe("rejected");
});

test("a failed archive of the derived twin puts the primary back", async () => {
  fs.mkdirSync(file().replace(".md", ".derived.md"));
  await expect(retireAsset(ref, hash())).rejects.toThrow();
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(fs.readdirSync(path.join(storage.stashDir, ".akm/memory-cleanup/archive"))).toEqual([]);
  expect(listProposals(storage.stashDir, { includeArchive: true })[0]?.status).toBe("rejected");
});

test("a revert that crashed after moving the file back resumes; a different file at the path is not overwritten", async () => {
  const receipt = await retireAsset(ref, hash());
  const [dir] = archived(receipt);
  const archivedFile = path.join(dir!, "memories/manual.md");
  fs.renameSync(archivedFile, file());
  expect((await revert(receipt)).proposal.status).toBe("reverted");
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(fs.existsSync(dir!)).toBe(false);

  const second = await retireAsset(ref, hash());
  const [again] = archived(second);
  fs.rmSync(path.join(again!, "memories/manual.md"));
  fs.writeFileSync(file(), "A new note reusing the name");
  await expect(revert(second)).rejects.toThrow("does not match what was retired");
  expect(fs.readFileSync(file(), "utf8")).toBe("A new note reusing the name");
});

test("a stale revision is refused without changing the active file or minting a proposal", async () => {
  await expect(retireAsset(ref, "stale")).rejects.toThrow("changed");
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(listProposals(storage.stashDir, { includeArchive: true })).toHaveLength(0);
});

test("a failed accept leaves the proposal rejected and the asset in place", async () => {
  const accept = await import("../../../src/commands/proposal/proposal");
  const real = accept.akmProposalAccept;
  const spy = spyOn(accept, "akmProposalAccept").mockImplementation(async (options) => {
    fs.appendFileSync(file(), "late edit");
    return real(options);
  });
  try {
    await expect(retireAsset(ref, hash())).rejects.toThrow("changed");
  } finally {
    spy.mockRestore();
  }
  expect(fs.readFileSync(file(), "utf8")).toBe(`${body}late edit`);
  expect(fs.existsSync(path.join(storage.stashDir, ".akm/memory-cleanup/archive"))).toBe(false);
  expect(listProposals(storage.stashDir, { includeArchive: true })[0]?.status).toBe("rejected");
});

test("read-only bundles, skill packages and protected files cannot be retired", async () => {
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
  const secret = path.join(storage.stashDir, "projects/demo/secrets/token.md");
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, "planted-private-secret");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  await expect(retireAsset("stash//secrets/projects/demo/secrets/token.md", hash())).rejects.toThrow("single-file");
  expect(fs.readFileSync(secret, "utf8")).toBe("planted-private-secret");
  expect(listProposals(storage.stashDir, { includeArchive: true })).toHaveLength(0);
});

test("Git retirement commits only its paths and the manual archive is grace-purged like any retirement", async () => {
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
  const committed = git(storage.stashDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
    .trim()
    .split("\n");
  const [dir] = archived(receipt);
  const rel = (p: string) => path.relative(storage.stashDir, p);
  expect(committed.sort()).toEqual(
    ["memories/manual.md", rel(path.join(dir!, "cleanup.md")), rel(path.join(dir!, "memories/manual.md"))].sort(),
  );
  expect(git(storage.stashDir, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
  expect(purgeGracedArchive(storage.stashDir, new Date("2100-01-01"))).toEqual({ purgedDirs: 1, purgedFiles: 1 });
  expect(fs.existsSync(path.join(dir!, "memories/manual.md"))).toBe(false);
  expect(fs.existsSync(path.join(dir!, "cleanup.md"))).toBe(true);
  // Past the purge, revert rewrites the asset from the proposal's recorded bytes.
  await revert(receipt);
  expect(fs.readFileSync(file(), "utf8")).toBe(body);
  expect(fs.existsSync(dir!)).toBe(false);
  expect(git(storage.stashDir, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
});
