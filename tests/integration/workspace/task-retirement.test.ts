// Integration: retire proposals and workspace retirement use the real scheduler owner with an in-memory native backend.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept, akmProposalRevert } from "../../../src/commands/proposal/proposal";
import { createRetireProposal, getProposal } from "../../../src/commands/proposal/repository";
import { akmTasksDisable, akmTasksSync } from "../../../src/commands/tasks/tasks";
import { loadConfig, saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import * as backends from "../../../src/tasks/backends";
import { CRON_BACKEND } from "../../../src/tasks/backends/cron";
import { documents } from "../../../src/workspace";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let table: string;
let failWrite: boolean;
let duringWrite: (() => void) | undefined;
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
  duringWrite = undefined;
  backend = CRON_BACKEND({
    exec: {
      read: () => ({ status: 0, stdout: table, stderr: "" }),
      write: (content) => {
        if (failWrite) return { status: 1, stdout: "", stderr: "native scheduler unavailable" };
        duringWrite?.();
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

test("a disabled task can archive with an explicit warning when native cleanup cannot be inspected", async () => {
  saveConfig({ ...loadConfig(), scheduler: { enabled: ["stash//tasks/other"] } });
  table = "";
  selection.mockClear();
  selection.mockImplementation(() => {
    throw new Error("scheduler is unavailable");
  });
  const receipt = await documents.retire({ ref, revision: revision() });
  expect(receipt.warnings).toHaveLength(1);
  expect(receipt.warnings[0]).toContain("native scheduler cleanup is unverified: scheduler is unavailable");
  expect(selection).toHaveBeenCalled();
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

test("a failed task-disable followed by a fresh retirement still removes native leftovers", async () => {
  failWrite = true;
  const disabled = await akmTasksDisable(ref, {}, { backend });
  expect(disabled.sync.failures.length).toBeGreaterThan(0);
  expect(loadConfig().scheduler?.enabled).not.toContain(ref);
  expect((await backend.list()).some((row) => row.invocation?.[2] === "nightly")).toBe(true);
  await expect(documents.retire({ ref, revision: revision() })).rejects.toThrow("native scheduler unavailable");
  expect(fs.readFileSync(taskFile(), "utf8")).toBe(source);
  failWrite = false;
  const receipt = await documents.retire({ ref, revision: revision() });
  expect(receipt.warnings).toEqual([]);
  expect(fs.existsSync(taskFile())).toBe(false);
  expect((await backend.list()).some((row) => row.invocation?.[2] === "nightly")).toBe(false);
});

test("fresh workspace retries after rejected retirement cannot hide failed native cleanup", async () => {
  failWrite = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(documents.retire({ ref, revision: revision() })).rejects.toThrow("native scheduler unavailable");
    expect(fs.readFileSync(taskFile(), "utf8")).toBe(source);
    expect((await backend.list()).some((row) => row.invocation?.[2] === "nightly")).toBe(true);
  }
  failWrite = false;
  const receipt = await documents.retire({ ref, revision: revision() });
  expect(receipt.warnings).toEqual([]);
  expect((await backend.list()).some((row) => row.invocation?.[2] === "nightly")).toBe(false);
});

test("proposal acceptance exposes incomplete cleanup when disabled native state is unknown", async () => {
  failWrite = true;
  await akmTasksDisable(ref, {}, { backend });
  const proposal = createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() });
  selection.mockImplementation(() => {
    throw new Error("scheduler is unavailable");
  });
  const result = await akmProposalAccept({ id: proposal.id });
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings?.[0]).toContain("Installed bindings may remain");
  expect(fs.existsSync(taskFile())).toBe(false);
});

test("an explicitly inactive task with no native bindings needs no reconcile or other source validation", async () => {
  table = "";
  saveConfig({ ...loadConfig(), scheduler: { enabled: ["stash//tasks/other"] } });
  fs.writeFileSync(path.join(storage.stashDir, "tasks/other.yml"), "version: 4\nrun: [unterminated\n");
  const receipt = await documents.retire({ ref, revision: revision() });
  expect(receipt.warnings).toEqual([]);
  expect(table).toBe("");
  expect(fs.existsSync(taskFile())).toBe(false);
});

for (const resume of [false, true]) {
  test(`a source edited during scheduler reconciliation is not archived (resume=${resume})`, async () => {
    const proposal = createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() });
    if (resume) {
      failWrite = true;
      await expect(akmProposalAccept({ id: proposal.id })).rejects.toThrow("native scheduler unavailable");
      failWrite = false;
    }
    duringWrite = () => {
      duringWrite = undefined;
      fs.appendFileSync(taskFile(), "# edit during native cleanup\n");
    };
    await expect(akmProposalAccept({ id: proposal.id })).rejects.toMatchObject({ code: "PROPOSAL_STALE" });
    expect(fs.readFileSync(taskFile(), "utf8")).toBe(`${source}# edit during native cleanup\n`);
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("pending");
    expect(getProposal(storage.stashDir, proposal.id).retiredArchive).toBeUndefined();
  });
}

for (const detail of ["brief", "normal", "full"] as const) {
  test(`proposal CLI preserves incomplete cleanup warnings at detail ${detail}`, async () => {
    failWrite = true;
    await akmTasksDisable(ref, {}, { backend });
    const proposal = createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() });
    selection.mockImplementation(() => {
      throw new Error("scheduler is unavailable");
    });
    const result = await runCliCapture(["proposal", "accept", proposal.id, "--detail", detail]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).warnings?.[0]).toContain("native scheduler cleanup is unverified");
  });
}

test("proposal CLI batch acceptance retains per-proposal incomplete cleanup warnings", async () => {
  failWrite = true;
  await akmTasksDisable(ref, {}, { backend });
  await akmTasksDisable("stash//tasks/other", {}, { backend });
  const ids = [ref, "stash//tasks/other"].map(
    (taskRef) => createRetireProposal(storage.stashDir, { ref: taskRef, source: "propose" }).id,
  );
  selection.mockImplementation(() => {
    throw new Error("scheduler is unavailable");
  });
  const result = await runCliCapture(["proposal", "accept", ...ids]);
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.results).toHaveLength(2);
  for (const item of output.results) expect(item.warnings?.[0]).toContain("native scheduler cleanup is unverified");
});

test("proposal CLI text output displays incomplete cleanup warnings", async () => {
  failWrite = true;
  await akmTasksDisable(ref, {}, { backend });
  const proposal = createRetireProposal(storage.stashDir, { ref, source: "propose", expectedRevision: revision() });
  selection.mockImplementation(() => {
    throw new Error("scheduler is unavailable");
  });
  const result = await runCliCapture(["proposal", "accept", proposal.id, "--format", "text"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    "Warning: Task stash//tasks/nightly is disabled in local config, but native scheduler cleanup is unverified",
  );
});

test("an unreadable legacy descriptor makes matching native ownership unknown, never absent", async () => {
  saveConfig({ ...loadConfig(), scheduler: { enabled: [] } });
  const missingContext = path.join(storage.root, "missing-context.json");
  table = [
    "# akm:task nightly BEGIN",
    `0 2 * * * /usr/local/bin/akm --scheduler-context ${missingContext} task run nightly --bundle stash --scheduled > /tmp/nightly.log 2>&1`,
    "# akm:task nightly END",
    "",
  ].join("\n");
  expect((await backend.list())[0]?.contextPath).toBe(missingContext);
  const before = table;
  const receipt = await documents.retire({ ref, revision: revision() });
  expect(receipt.warnings).toHaveLength(1);
  expect(receipt.warnings[0]).toContain("native scheduler cleanup is unverified");
  expect(receipt.warnings[0]).toContain("owning bundle path could not be read");
  expect(table).toBe(before);
});

test("a matching logical task with a definite foreign bundle path is preserved and not attributed locally", async () => {
  saveConfig({ ...loadConfig(), scheduler: { enabled: [] } });
  table = "";
  await backend.install(
    {
      id: "nightly",
      logicalSource: { kind: "task", ref },
      cron: "0 2 * * *",
      source: "foreign.yml",
      ordinal: 0,
      enabled: true,
      invocation: ["task", "run", "nightly", "--bundle", "stash", "--scheduled"],
    },
    { environment: { AKM_BUNDLE_DIR: path.join(storage.root, "another-host") } },
  );
  const before = table;
  const receipt = await documents.retire({ ref, revision: revision() });
  expect(receipt.warnings).toEqual([]);
  expect(table).toBe(before);
});

test("enabled retirement verifies remaining unknown ownership after removing its known native rows", async () => {
  const missingContext = path.join(storage.root, "missing-enabled-context.json");
  const unknownRow = [
    "# akm:task nightly-unknown BEGIN",
    `0 2 * * * /usr/local/bin/akm --scheduler-context ${missingContext} task run nightly --bundle stash --scheduled > /tmp/nightly-unknown.log 2>&1`,
    "# akm:task nightly-unknown END",
    "",
  ].join("\n");
  table += unknownRow;
  expect((await backend.list()).filter((row) => row.invocation?.[2] === "nightly")).toHaveLength(3);
  const receipt = await documents.retire({ ref, revision: revision() });
  expect(receipt.warnings?.[0]).toContain("owning bundle path could not be read");
  expect(loadConfig().scheduler?.enabled).not.toContain(ref);
  const remaining = (await backend.list()).filter((row) => row.invocation?.[2] === "nightly");
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.contextPath).toBe(missingContext);
  expect(table).toContain(unknownRow.trim());
});

test("a backend reporting successful removal does not prove that native bindings disappeared", async () => {
  const uninstall = spyOn(backend, "uninstall").mockImplementation(() => {});
  try {
    await expect(documents.retire({ ref, revision: revision() })).rejects.toThrow(
      "remains installed in the native scheduler",
    );
    expect(fs.readFileSync(taskFile(), "utf8")).toBe(source);
    expect((await backend.list()).some((row) => row.invocation?.[2] === "nightly")).toBe(true);
  } finally {
    uninstall.mockRestore();
  }
});
