import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept, akmProposalReject, akmProposalRevert } from "../../../src/commands/proposal/proposal";
import { createProposal, getProposal, isProposalSkipped } from "../../../src/commands/proposal/repository";
import { parseFrontmatter } from "../../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import { txnNamespaceDir } from "../../../src/core/fs-txn";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";
import { crashProposalAt as crashProposalAtHelper } from "../_helpers/proposal-crash";

const CONTENT =
  "---\ndescription: Durable proposal content\nwhen_to_use: Testing proposal crash recovery\n---\n\nDURABLE ACCEPT.\n";
let storage: IsolatedAkmStorage;
let markers: ReturnType<typeof makeSandboxDir>;
const children: ChildProcess[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  markers = makeSandboxDir("akm-proposal-crash");
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
  });
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
  await crashProposalAtHelper(markers.dir, children, phase, proposalId, operation, target);
}

/**
 * D2 (#730): promotion now stamps OKF v0.2 provenance (`generated`/`verified`)
 * onto the written frontmatter, so an accepted asset's on-disk bytes are no
 * longer expected to be byte-identical to the pre-stamp proposed content.
 * This checks the parts these crash-recovery tests actually care about —
 * frontmatter fields and body — survived the crash/recovery untouched.
 */
function expectAcceptedContent(actual: string, proposedContent: string): void {
  const { data, content: body } = parseFrontmatter(actual);
  const expected = parseFrontmatter(proposedContent);
  expect(data.description).toBe(expected.data.description);
  expect(data.when_to_use).toBe(expected.data.when_to_use);
  expect(body).toBe(expected.content);
}

function seedProposal(name: string): { id: string; assetPath: string; original: string; content: string } {
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
  return { id: proposal.id, assetPath, original, content: proposal.payload.content };
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
      expectAcceptedContent(fs.readFileSync(seeded.assetPath, "utf8"), seeded.content);
      const proposal = getProposal(storage.stashDir, seeded.id);
      expect(proposal.status).toBe("accepted");
      expect(proposal.backupContent).toBe(seeded.original);
      expect(proposal.acceptedTarget?.contentHash).toBeDefined();
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
        bundles: { shm: { path: stashDir, writable: true } } as AkmConfig["bundles"],
        defaultBundle: "shm",
        defaultWriteTarget: "shm",
      } as AkmConfig;
      const proposal = createProposal(stashDir, {
        ref: "lessons/cross-device-accept",
        source: "distill",
        force: true,
        target: { source: "shm", root: stashDir },
        payload: { content: CONTENT },
      });
      if (isProposalSkipped(proposal)) throw new Error("unexpected skip");

      const result = await akmProposalAccept({ stashDir, id: proposal.id, config });
      expect(result.ok).toBe(true);
      expectAcceptedContent(
        fs.readFileSync(path.join(stashDir, "lessons", "cross-device-accept.md"), "utf8"),
        proposal.payload.content,
      );
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  });

  test("rejects a transaction journal missing current target identity", async () => {
    const seeded = seedProposal("missing-journal-target-kind");
    await crashProposalAt("index-finalized", seeded.id);
    const namespace = txnNamespaceDir(storage.stashDir);
    const transactionDir = fs.readdirSync(namespace)[0] as string;
    const journalPath = path.join(namespace, transactionDir, "journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      payload: Record<string, unknown>;
    };
    delete journal.payload.targetKind;
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: seeded.id })).rejects.toThrow(
      /unsafe proposal transaction|different target|target identity/i,
    );
    expect(fs.existsSync(journalPath)).toBe(true);
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
    expectAcceptedContent(fs.readFileSync(seeded.assetPath, "utf8"), seeded.content);
  });

  test("target-B retry globally recovers a target-A accept and fails closed", async () => {
    const targetA = path.join(storage.root, "target-a");
    const targetB = path.join(storage.root, "target-b");
    fs.mkdirSync(path.join(targetA, "lessons"), { recursive: true });
    fs.mkdirSync(path.join(targetB, "lessons"), { recursive: true });
    writeSandboxConfig({
      bundles: { a: { path: targetA, writable: true }, b: { path: targetB, writable: true } },
      defaultBundle: "a",
      defaultWriteTarget: "a",
      semanticSearchMode: "off",
    });
    const proposal = createProposal(storage.stashDir, {
      ref: "lessons/multi-target-crash",
      source: "distill",
      force: true,
      target: { source: "a", root: targetA },
      payload: { content: CONTENT },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
    await crashProposalAt("asset-published", proposal.id, "accept", "a");

    await expect(akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, target: "b" })).rejects.toThrow(
      /bound|different|target/i,
    );
    expectAcceptedContent(
      fs.readFileSync(path.join(targetA, "lessons", "multi-target-crash.md"), "utf8"),
      proposal.payload.content,
    );
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
      bundles: { a: { path: targetA, writable: true }, b: { path: targetB, writable: true } },
      defaultBundle: "a",
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
      target: { source: "a", root: targetA },
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
});
