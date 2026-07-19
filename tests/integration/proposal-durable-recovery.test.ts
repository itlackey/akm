import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept, akmProposalReject, akmProposalRevert } from "../../src/commands/proposal/proposal";
import { createProposal, getProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import type { AkmConfig } from "../../src/core/config/config";
import { readEvents } from "../../src/core/events";
import { openStateDatabase } from "../../src/core/state-db";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const RUNNER = path.join(import.meta.dir, "_helpers", "proposal-crash-runner.ts");
const CONTENT =
  "---\ndescription: Durable proposal content\nwhen_to_use: Testing proposal crash recovery\n---\n\nDURABLE ACCEPT.\n";
let storage: IsolatedAkmStorage;
let markers: ReturnType<typeof makeSandboxDir>;
const children: ChildProcess[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  markers = makeSandboxDir("akm-proposal-crash");
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  markers.cleanup();
  storage.cleanup();
});

async function crashProposalAt(
  phase: string,
  proposalId: string,
  operation = "accept",
  target?: string,
): Promise<void> {
  const marker = path.join(markers.dir, `${operation}-${phase}.ready`);
  const child = spawn("bun", [RUNNER, phase, marker, proposalId, operation, ...(target ? [target] : [])], {
    env: { ...process.env },
    stdio: "ignore",
  });
  children.push(child);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error(`proposal crash runner did not reach ${phase}`);
    }
    await Bun.sleep(10);
  }
  const markerContent = fs.readFileSync(marker, "utf8");
  if (markerContent === "unsupported") {
    throw new Error(`proposal crash runner does not support ${phase}`);
  }
  if (markerContent.startsWith("error:")) throw new Error(markerContent);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function seedProposal(name: string): { id: string; assetPath: string; original: string } {
  const assetPath = path.join(storage.stashDir, "lessons", `${name}.md`);
  const original =
    "---\ndescription: Original durable content\nwhen_to_use: Testing proposal crash recovery\n---\n\nORIGINAL.\n";
  fs.writeFileSync(assetPath, original, "utf8");
  const proposal = createProposal(storage.stashDir, {
    ref: `lessons/${name}`,
    source: "distill",
    force: true,
    payload: { content: CONTENT },
  });
  if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
  return { id: proposal.id, assetPath, original };
}

describe("proposal accept durable crash recovery", () => {
  for (const phase of [
    "prepared",
    "asset-published",
    "proposal-persisted",
    "index-finalized",
    "event-persisted",
  ] as const) {
    test(`recovers SIGKILL at ${phase} without losing backup/status/index/event`, async () => {
      const seeded = seedProposal(`crash-${phase}`);
      await crashProposalAt(phase, seeded.id);

      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: seeded.id });
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(seeded.assetPath, "utf8")).toBe(CONTENT);
      const proposal = getProposal(storage.stashDir, seeded.id);
      expect(proposal.status).toBe("accepted");
      expect(proposal.backupContent).toBe(seeded.original);
      expect(proposal.acceptedContentHash).toBeDefined();
      const events = readEvents({ type: "promoted", ref: proposal.ref }).events.filter(
        (event) => event.metadata?.proposalId === seeded.id,
      );
      expect(events).toHaveLength(1);
    });
  }

  test("publishes atomically when AKM data and the target are on different filesystems", async () => {
    if (!fs.existsSync("/dev/shm")) return;
    const stashDir = fs.mkdtempSync("/dev/shm/akm-proposal-cross-device-");
    try {
      if (fs.statSync(stashDir).dev === fs.statSync(storage.dataDir).dev) return;
      fs.mkdirSync(path.join(stashDir, "lessons"), { recursive: true });
      const config = {
        stashDir,
        sources: [{ type: "filesystem", name: "shm", path: stashDir, writable: true }],
        defaultWriteTarget: "shm",
      } as AkmConfig;
      const proposal = createProposal(stashDir, {
        ref: "lessons/cross-device-accept",
        source: "distill",
        force: true,
        payload: { content: CONTENT },
      });
      if (isProposalSkipped(proposal)) throw new Error("unexpected skip");

      const result = await akmProposalAccept({ stashDir, id: proposal.id, config });
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(stashDir, "lessons", "cross-device-accept.md"), "utf8")).toBe(CONTENT);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  for (const phase of [
    "prepared",
    "asset-published",
    "proposal-persisted",
    "index-finalized",
    "event-persisted",
  ] as const) {
    test(`recovers revert SIGKILL at ${phase} exactly once`, async () => {
      const seeded = seedProposal(`revert-crash-${phase}`);
      await akmProposalAccept({ stashDir: storage.stashDir, id: seeded.id });
      await crashProposalAt(phase, seeded.id, "revert");

      const result = await akmProposalRevert({ stashDir: storage.stashDir, id: seeded.id });
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(seeded.assetPath, "utf8")).toBe(seeded.original);
      expect(getProposal(storage.stashDir, seeded.id).status).toBe("reverted");
      const events = readEvents({ type: "proposal_reverted", ref: result.ref }).events.filter(
        (event) => event.metadata?.proposalId === seeded.id,
      );
      expect(events).toHaveLength(1);
    });
  }

  test("reject recovers a pending accept transaction before checking status", async () => {
    const seeded = seedProposal("reject-recovers-accept");
    await crashProposalAt("asset-published", seeded.id);

    await expect(
      akmProposalReject({ stashDir: storage.stashDir, id: seeded.id, reason: "must not reject committed accept" }),
    ).rejects.toThrow(/not pending/i);
    expect(getProposal(storage.stashDir, seeded.id).status).toBe("accepted");
    expect(fs.readFileSync(seeded.assetPath, "utf8")).toBe(CONTENT);
  });

  test("target-B retry globally recovers a target-A accept and fails closed", async () => {
    const targetA = path.join(storage.root, "target-a");
    const targetB = path.join(storage.root, "target-b");
    fs.mkdirSync(path.join(targetA, "lessons"), { recursive: true });
    fs.mkdirSync(path.join(targetB, "lessons"), { recursive: true });
    writeSandboxConfig({
      sources: [
        { type: "filesystem", name: "a", path: targetA, writable: true },
        { type: "filesystem", name: "b", path: targetB, writable: true },
      ],
      defaultWriteTarget: "a",
      semanticSearchMode: "off",
    });
    const proposal = createProposal(storage.stashDir, {
      ref: "lessons/multi-target-crash",
      source: "distill",
      force: true,
      payload: { content: CONTENT },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
    await crashProposalAt("asset-published", proposal.id, "accept", "a");

    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, target: "b" })).rejects.toThrow(
      /bound|different|target/i,
    );
    expect(fs.readFileSync(path.join(targetA, "lessons", "multi-target-crash.md"), "utf8")).toBe(CONTENT);
    expect(fs.existsSync(path.join(targetB, "lessons", "multi-target-crash.md"))).toBe(false);
    const accepted = getProposal(storage.stashDir, proposal.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedTarget?.source).toBe("a");
    const events = readEvents({ type: "promoted", ref: proposal.ref }).events.filter(
      (event) => event.metadata?.proposalId === proposal.id,
    );
    expect(events).toHaveLength(1);
  });

  test("target-B retry globally recovers a target-A revert and fails closed", async () => {
    const targetA = path.join(storage.root, "revert-target-a");
    const targetB = path.join(storage.root, "revert-target-b");
    fs.mkdirSync(path.join(targetA, "lessons"), { recursive: true });
    fs.mkdirSync(path.join(targetB, "lessons"), { recursive: true });
    writeSandboxConfig({
      sources: [
        { type: "filesystem", name: "a", path: targetA, writable: true },
        { type: "filesystem", name: "b", path: targetB, writable: true },
      ],
      defaultWriteTarget: "a",
      semanticSearchMode: "off",
    });
    const original =
      "---\ndescription: Target A original content\nwhen_to_use: Testing cross target revert recovery\n---\n\nORIGINAL A.\n";
    fs.writeFileSync(path.join(targetA, "lessons", "multi-target-revert.md"), original, "utf8");
    const proposal = createProposal(storage.stashDir, {
      ref: "lessons/multi-target-revert",
      source: "distill",
      force: true,
      payload: { content: CONTENT },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
    await akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, target: "a" });
    await crashProposalAt("asset-published", proposal.id, "revert", "a");

    await expect(akmProposalRevert({ stashDir: storage.stashDir, id: proposal.id, target: "b" })).rejects.toThrow(
      /bound|different|target/i,
    );
    expect(fs.readFileSync(path.join(targetA, "lessons", "multi-target-revert.md"), "utf8")).toBe(original);
    expect(fs.existsSync(path.join(targetB, "lessons", "multi-target-revert.md"))).toBe(false);
    expect(getProposal(storage.stashDir, proposal.id).status).toBe("reverted");
    const events = readEvents({ type: "proposal_reverted", ref: proposal.ref }).events.filter(
      (event) => event.metadata?.proposalId === proposal.id,
    );
    expect(events).toHaveLength(1);
  });

  for (const phase of ["reject-state-persisted", "reject-event-persisted"] as const) {
    test(`reject recovers SIGKILL at ${phase} with exactly one event`, async () => {
      const proposal = createProposal(storage.stashDir, {
        ref: `lessons/${phase}`,
        source: "distill",
        force: true,
        payload: { content: CONTENT },
      });
      if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
      await crashProposalAt(phase, proposal.id, "reject");

      const result = await akmProposalReject({ stashDir: storage.stashDir, id: proposal.id, reason: "durable reject" });
      expect(result.proposal.status).toBe("rejected");
      const events = readEvents({ type: "rejected", ref: proposal.ref }).events.filter(
        (event) => event.metadata?.proposalId === proposal.id,
      );
      expect(events).toHaveLength(1);
    });
  }

  test("legacy missing-file revert survives SIGKILL after target derivation and before journal creation", async () => {
    const seeded = seedProposal("legacy-derived-restart");
    await akmProposalAccept({ stashDir: storage.stashDir, id: seeded.id });
    const db = openStateDatabase();
    const row = db.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(seeded.id) as {
      metadata_json: string;
    };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    delete metadata.acceptedContentHash;
    delete metadata.acceptedTarget;
    db.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), seeded.id);
    db.close();
    fs.unlinkSync(seeded.assetPath);

    await crashProposalAt("legacy-target-derived", seeded.id, "revert");

    const persistedDb = openStateDatabase();
    const persistedRow = persistedDb.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(seeded.id) as {
      metadata_json: string;
    };
    const persisted = JSON.parse(persistedRow.metadata_json) as Record<string, unknown>;
    persistedDb.close();
    expect(persisted.legacyAcceptedTargetDerived).toBe(true);
    expect(persisted.legacyAcceptedAssetWasAbsent).toBe(true);
    expect(persisted.acceptedTarget).toBeDefined();

    const result = await akmProposalRevert({ stashDir: storage.stashDir, id: seeded.id });
    expect(result.proposal.status).toBe("reverted");
    expect(fs.readFileSync(seeded.assetPath, "utf8")).toBe(seeded.original);
  });
});
