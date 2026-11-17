// Integration: retire proposals and workspace retirement use the real scheduler owner with an in-memory native backend.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept, akmProposalRevert } from "../../../src/commands/proposal/proposal";
import { createRetireProposal, getProposal } from "../../../src/commands/proposal/repository";
import { akmTasksSync } from "../../../src/commands/tasks/tasks";
import { loadConfig, saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import * as backends from "../../../src/tasks/backends";
import { CRON_BACKEND } from "../../../src/tasks/backends/cron";
import { documents } from "../../../src/workspace";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let table: string;
let failWrite: boolean;
let backend: ReturnType<typeof CRON_BACKEND>;
let selection: ReturnType<typeof spyOn>;
const ref = "stash//tasks/nightly";
const source = "version: 4\nrun: echo nightly\nschedule:\n  - cron: '0 2 * * *'\n  - cron: '0 4 * * *'\n";
const revision = () => createHash("sha256").update(source).digest("hex");
const taskFile = () => path.join(storage.stashDir, "tasks/nightly.yml");

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  table = "";
  failWrite = false;
  backend = CRON_BACKEND({
    exec: {
      read: () => ({ status: 0, stdout: table, stderr: "" }),
      write: (content) => {
        if (failWrite) return { status: 1, stdout: "", stderr: "native scheduler unavailable" };
        table = content;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
    fs: { ensureDir() {} },
    logDir: path.join(storage.cacheDir, "scheduler-logs"),
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false,
  });
  selection = spyOn(backends, "selectBackend").mockReturnValue(backend);
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    scheduler: { enabled: [ref, "stash//tasks/other"] },
  });
  fs.mkdirSync(path.dirname(taskFile()), { recursive: true });
  fs.writeFileSync(taskFile(), source);
  fs.writeFileSync(path.join(storage.stashDir, "tasks/other.yml"), source.replace("nightly", "other"));
  await akmIndex({ stashDir: storage.stashDir, full: true });
  expect((await akmTasksSync({ backend })).failures).toEqual([]);
  for (const [id, bundle, bundleDir] of [
    ["another-bundle", "elsewhere", storage.stashDir],
    ["another-host", "stash", path.join(storage.root, "other-host")],
  ]) {
    await backend.install(
      {
        id: id!,
        logicalSource: { kind: "task", ref: `${bundle}//tasks/${id}` },
        cron: "0 3 * * *",
        source: "foreign.yml",
        ordinal: 0,
        enabled: true,
        invocation: ["task", "run", id!, "--bundle", bundle!, "--scheduled"],
      },
      { environment: { AKM_BUNDLE_DIR: bundleDir! } },
    );
  }
});

afterEach(() => {
  selection.mockRestore();
  storage.cleanup();
});

for (const through of ["workspace", "proposal"] as const) {
  test(`${through} retirement removes all native bindings and activation; revert restores only the source`, async () => {
    const beforeOther = (await backend.list()).filter((row) => row.invocation?.[2] !== "nightly");
    const proposalId =
      through === "workspace"
        ? (await documents.retire({ ref, revision: revision() })).proposalId
        : (
            await akmProposalAccept({
              id: createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() }).id,
            })
          ).id;
    expect(fs.existsSync(taskFile())).toBe(false);
    expect(loadConfig().scheduler?.enabled).toEqual(["stash//tasks/other"]);
    expect(await backend.list()).toEqual(beforeOther);
    const proposal = getProposal(storage.stashDir, proposalId);
    const archive = proposal.retiredArchive?.dirs[0];
    expect(archive).toBeDefined();
    expect(fs.readFileSync(path.join(storage.stashDir, archive!, "tasks/nightly.yml"), "utf8")).toBe(source);
    await akmProposalAccept({ id: proposalId });
    expect(await backend.list()).toEqual(beforeOther);
    await akmProposalRevert({ id: proposalId });
    expect(fs.readFileSync(taskFile(), "utf8")).toBe(source);
    expect(loadConfig().scheduler?.enabled).toEqual(["stash//tasks/other"]);
    expect(await backend.list()).toEqual(beforeOther);
    expect((await akmTasksSync({ backend })).failures).toEqual([]);
    expect(await backend.list()).toEqual(beforeOther);
  });
}

test("failed native removal leaves bytes in place and disables activation; retry completes the same proposal", async () => {
  const proposal = createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() });
  failWrite = true;
  await expect(akmProposalAccept({ id: proposal.id })).rejects.toThrow("native scheduler unavailable");
  expect(fs.readFileSync(taskFile(), "utf8")).toBe(source);
  expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
  expect(loadConfig().scheduler?.enabled).toEqual(["stash//tasks/other"]);
  expect((await backend.list()).some((row) => row.id === "nightly")).toBe(true);
  failWrite = false;
  await akmProposalAccept({ id: proposal.id });
  expect(fs.existsSync(taskFile())).toBe(false);
  expect((await backend.list()).every((row) => row.invocation?.[2] !== "nightly")).toBe(true);
});

test("a stale proposal does not change scheduler config or native rows", async () => {
  const proposal = createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() });
  fs.appendFileSync(taskFile(), "# late edit\n");
  const before = table;
  await expect(akmProposalAccept({ id: proposal.id })).rejects.toThrow("changed");
  expect(table).toBe(before);
  expect(loadConfig().scheduler?.enabled).toEqual([ref, "stash//tasks/other"]);
});

test("a never-enabled task retires without accessing an unavailable scheduler", async () => {
  saveConfig({ ...loadConfig(), scheduler: { enabled: ["stash//tasks/other"] } });
  table = "";
  selection.mockClear();
  selection.mockImplementation(() => {
    throw new Error("scheduler is unavailable");
  });
  const receipt = await documents.retire({ ref, revision: revision() });
  expect(receipt.warnings).toEqual([]);
  expect(selection).not.toHaveBeenCalled();
  expect(fs.existsSync(taskFile())).toBe(false);
  expect(loadConfig().scheduler?.enabled).toEqual(["stash//tasks/other"]);
});

test("a retry after failed removal still refuses a later edit before changing the scheduler", async () => {
  const proposal = createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() });
  failWrite = true;
  await expect(akmProposalAccept({ id: proposal.id })).rejects.toThrow("native scheduler unavailable");
  fs.appendFileSync(taskFile(), "# late edit\n");
  const before = table;
  failWrite = false;
  await expect(akmProposalAccept({ id: proposal.id })).rejects.toThrow("changed");
  expect(table).toBe(before);
  expect(fs.readFileSync(taskFile(), "utf8")).toBe(`${source}# late edit\n`);
});

test("a legacy host adopts its other installed tasks before removing the retired activation", async () => {
  const { scheduler: _scheduler, ...config } = loadConfig();
  saveConfig(config);
  await documents.retire({ ref, revision: revision() });
  expect(loadConfig().scheduler?.enabled).toEqual(["stash//tasks/other"]);
  expect((await backend.list()).some((row) => row.invocation?.[2] === "nightly")).toBe(false);
  expect((await backend.list()).filter((row) => row.invocation?.[2] === "other")).toHaveLength(2);
});

test("an unrelated source failure is reported with its path even when the retiring task's rows were removed", async () => {
  fs.writeFileSync(path.join(storage.stashDir, "tasks/other.yml"), "version: 4\nrun: [unterminated\n");
  const proposal = createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() });
  await expect(akmProposalAccept({ id: proposal.id })).rejects.toThrow("tasks/other.yml");
  expect((await backend.list()).some((row) => row.invocation?.[2] === "nightly")).toBe(false);
  expect(fs.readFileSync(taskFile(), "utf8")).toBe(source);
  expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
});
