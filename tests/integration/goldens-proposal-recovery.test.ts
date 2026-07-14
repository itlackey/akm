// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: proposal accept/revert/reject crash (SIGKILL) recovery
 * outcomes (WI-03, plan §11 Chunk 0a / R3). Integration scope (crash windows
 * only — brief §3.4): parameterizes the existing
 * `tests/integration/_helpers/proposal-crash-runner.ts` subprocess harness
 * (UNCHANGED — used exactly as `tests/integration/proposal-durable-recovery
 * .test.ts` already uses it; no `src/` or runner changes needed for this
 * chunk's scenarios).
 *
 * Pins: accept SIGKILL at each of the 5 pre-commit phases (`prepared` rolls
 * back; every later phase rolls forward — `repository.ts:1310-1355`
 * `recoverProposalTransactions`); revert crash exactly-once per phase;
 * reject crash exactly-one `rejected` event (`prepared` via the generic
 * journal-rename interception the runner already does for every phase,
 * `reject-state-persisted` / `reject-event-persisted` via the named
 * `_setProposalMutationHookForTests` hook, `repository.ts:1450,1471`); and
 * the reject-recovers-a-pending-accept ordering (`proposal.ts:169-186` —
 * `akmProposalReject` calls `recoverProposalTransactionsForStash` BEFORE its
 * own `status !== "pending"` check).
 *
 * Encoding (brief §3.2): journal phase sequences are informational data only
 * (`journalPhasesObserved`); events are golden as exactly-once counts, never
 * a raw id-keyed map; refs are fixture-local
 * (`tests/fixtures/goldens/journal/fixture-refs.ts`).
 *
 * Designation: `frozen-migration-input` (DESIGNATIONS.json) — preservation
 * oracle through Chunk 6.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmProposalAccept, akmProposalReject, akmProposalRevert } from "../../src/commands/proposal/proposal";
import { createProposal, getProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import { readEvents } from "../../src/core/events";
import { expectGolden } from "../_helpers/golden";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";
import {
  lessonContent,
  lessonRef,
  RECOVERY_ACCEPT_PREFIX,
  RECOVERY_REJECT_PREFIX,
  RECOVERY_REJECT_RECOVERS_ACCEPT_NAME,
  RECOVERY_REVERT_PREFIX,
} from "../fixtures/goldens/journal/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/journal/proposal-recovery.json";
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";
const RUNNER = path.join(import.meta.dir, "_helpers", "proposal-crash-runner.ts");

let storage: IsolatedAkmStorage;
let markers: ReturnType<typeof makeSandboxDir>;
const children: ChildProcess[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  markers = makeSandboxDir("akm-goldens-proposal-crash");
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  markers.cleanup();
  storage.cleanup();
});

/** Hold the crash runner at `phase`, then SIGKILL it. Mirrors proposal-durable-recovery.test.ts. */
async function crashProposalAt(
  phase: string,
  proposalId: string,
  operation: "accept" | "revert" | "reject" = "accept",
  target?: string,
): Promise<void> {
  // proposalId (always a fresh randomUUID per seeded proposal) disambiguates
  // marker filenames across multiple crashProposalAt calls at the same
  // (operation, phase) pair within a single test -- e.g. the golden-capture
  // test below crashes "accept" at "asset-published" both in its own loop
  // AND again for the reject-recovers-pending-accept ordering scenario. A
  // collision here would make the wait loop below see a STALE marker from
  // the earlier call and return immediately without actually holding the
  // new subprocess at its crash point.
  const marker = path.join(markers.dir, `${operation}-${phase}-${proposalId}.ready`);
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
  if (markerContent === "unsupported") throw new Error(`proposal crash runner does not support ${phase}`);
  if (markerContent.startsWith("error:")) throw new Error(markerContent);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function seedProposal(name: string): { id: string; assetPath: string; original: string; content: string } {
  const assetPath = path.join(storage.stashDir, "lessons", `${name}.md`);
  const original = lessonContent(name, "ORIGINAL BODY.");
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, original, "utf8");
  const content = lessonContent(name, "DURABLE ACCEPT BODY.");
  const proposal = createProposal(storage.stashDir, {
    ref: lessonRef(name),
    source: "distill",
    force: true,
    payload: { content },
  });
  if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
  return { id: proposal.id, assetPath, original, content };
}

/** Count of events matching {type, ref}, plus the distinct-idempotency-key shape (brief §3.2). */
function eventOutcome(type: string, ref: string): { matchingCount: number; distinctIdempotencyKeyCount: number } {
  const events = readEvents({ type, ref }).events;
  const keys = new Set(events.map((e) => String(e.metadata?.proposalTransactionId ?? "")));
  return { matchingCount: events.length, distinctIdempotencyKeyCount: keys.size };
}

const ACCEPT_PHASES = [
  "prepared",
  "asset-published",
  "proposal-persisted",
  "index-finalized",
  "event-persisted",
] as const;
const REJECT_PHASES = ["prepared", "reject-state-persisted", "reject-event-persisted"] as const;

describe("goldens: proposal accept crash recovery (WI-03, R3, integration)", () => {
  for (const phase of ACCEPT_PHASES) {
    test(`SIGKILL at ${phase} recovers without losing backup/status/index/event`, async () => {
      const name = `${RECOVERY_ACCEPT_PREFIX}-${phase}`;
      const seeded = seedProposal(name);
      await crashProposalAt(phase, seeded.id, "accept");

      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: seeded.id });
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(seeded.assetPath, "utf8")).toBe(seeded.content);
      const proposal = getProposal(storage.stashDir, seeded.id);
      expect(proposal.status).toBe("accepted");
      expect(proposal.backupContent).toBe(seeded.original);
      expect(proposal.acceptedContentHash).toBeDefined();
      const promoted = eventOutcome("promoted", lessonRef(name));
      expect(promoted.matchingCount).toBe(1);
      expect(promoted.distinctIdempotencyKeyCount).toBe(1);
    });
  }
});

describe("goldens: proposal revert crash recovery (WI-03, R3, integration)", () => {
  for (const phase of ACCEPT_PHASES) {
    test(`revert SIGKILL at ${phase} recovers exactly once`, async () => {
      const name = `${RECOVERY_REVERT_PREFIX}-${phase}`;
      const seeded = seedProposal(name);
      await akmProposalAccept({ stashDir: storage.stashDir, id: seeded.id });
      await crashProposalAt(phase, seeded.id, "revert");

      const result = await akmProposalRevert({ stashDir: storage.stashDir, id: seeded.id });
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(seeded.assetPath, "utf8")).toBe(seeded.original);
      expect(getProposal(storage.stashDir, seeded.id).status).toBe("reverted");
      const reverted = eventOutcome("proposal_reverted", lessonRef(name));
      expect(reverted.matchingCount).toBe(1);
      expect(reverted.distinctIdempotencyKeyCount).toBe(1);
    });
  }
});

describe("goldens: proposal reject crash recovery (WI-03, R3, integration)", () => {
  for (const phase of REJECT_PHASES) {
    test(`reject SIGKILL at ${phase} recovers with exactly one rejected event`, async () => {
      const name = `${RECOVERY_REJECT_PREFIX}-${phase}`;
      const proposal = createProposal(storage.stashDir, {
        ref: lessonRef(name),
        source: "distill",
        force: true,
        payload: { content: lessonContent(name, "REJECT ME.") },
      });
      if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
      await crashProposalAt(phase, proposal.id, "reject");

      const result = await akmProposalReject({ stashDir: storage.stashDir, id: proposal.id, reason: "durable reject" });
      expect(result.proposal.status).toBe("rejected");
      const rejected = eventOutcome("rejected", lessonRef(name));
      expect(rejected.matchingCount).toBe(1);
      expect(rejected.distinctIdempotencyKeyCount).toBe(1);
    });
  }

  test("reject recovers a pending accept transaction before checking status (proposal.ts:169-186 ordering)", async () => {
    const seeded = seedProposal(RECOVERY_REJECT_RECOVERS_ACCEPT_NAME);
    await crashProposalAt("asset-published", seeded.id, "accept");

    let errorMessage: string | undefined;
    try {
      await akmProposalReject({
        stashDir: storage.stashDir,
        id: seeded.id,
        reason: "must not reject a committed accept",
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    expect(errorMessage).toMatch(/not pending/i);
    // recoverProposalTransactionsForStash ran BEFORE the pending check, so the
    // interrupted accept was already rolled forward to "accepted" by the time
    // the reject's own status guard fired.
    expect(getProposal(storage.stashDir, seeded.id).status).toBe("accepted");
    expect(fs.readFileSync(seeded.assetPath, "utf8")).toBe(seeded.content);
  });
});

// ── Golden fixture capture ──────────────────────────────────────────────────
describe("golden fixture: serialize proposal crash recovery outcomes (WI-03, R3)", () => {
  test("golden fixture: proposal-recovery.json", async () => {
    const acceptOutcomes: Record<string, unknown> = {};
    for (const phase of ACCEPT_PHASES) {
      const name = `${RECOVERY_ACCEPT_PREFIX}-golden-${phase}`;
      const seeded = seedProposal(name);
      await crashProposalAt(phase, seeded.id, "accept");
      const result = await akmProposalAccept({ stashDir: storage.stashDir, id: seeded.id });
      const proposal = getProposal(storage.stashDir, seeded.id);
      acceptOutcomes[phase] = {
        ok: result.ok,
        status: proposal.status,
        backupContentMatchesOriginal: proposal.backupContent === seeded.original,
        acceptedContentHashPresent: proposal.acceptedContentHash !== undefined,
        assetContentMatchesProposal: fs.readFileSync(seeded.assetPath, "utf8") === seeded.content,
        promotedEvent: eventOutcome("promoted", lessonRef(name)),
        journalPhasesObserved: [phase],
      };
    }

    const revertOutcomes: Record<string, unknown> = {};
    for (const phase of ACCEPT_PHASES) {
      const name = `${RECOVERY_REVERT_PREFIX}-golden-${phase}`;
      const seeded = seedProposal(name);
      await akmProposalAccept({ stashDir: storage.stashDir, id: seeded.id });
      await crashProposalAt(phase, seeded.id, "revert");
      const result = await akmProposalRevert({ stashDir: storage.stashDir, id: seeded.id });
      revertOutcomes[phase] = {
        ok: result.ok,
        restoredByteIdentical: fs.readFileSync(seeded.assetPath, "utf8") === seeded.original,
        status: getProposal(storage.stashDir, seeded.id).status,
        revertedEvent: eventOutcome("proposal_reverted", lessonRef(name)),
        journalPhasesObserved: [phase],
      };
    }

    const rejectOutcomes: Record<string, unknown> = {};
    for (const phase of REJECT_PHASES) {
      const name = `${RECOVERY_REJECT_PREFIX}-golden-${phase}`;
      const proposal = createProposal(storage.stashDir, {
        ref: lessonRef(name),
        source: "distill",
        force: true,
        payload: { content: lessonContent(name, "REJECT ME.") },
      });
      if (isProposalSkipped(proposal)) throw new Error("unexpected skip");
      await crashProposalAt(phase, proposal.id, "reject");
      const result = await akmProposalReject({ stashDir: storage.stashDir, id: proposal.id, reason: "durable reject" });
      rejectOutcomes[phase] = {
        status: result.proposal.status,
        rejectedEvent: eventOutcome("rejected", lessonRef(name)),
        journalPhasesObserved: [phase],
      };
    }

    const orderingOutcome = await (async () => {
      const seeded = seedProposal(RECOVERY_REJECT_RECOVERS_ACCEPT_NAME);
      await crashProposalAt("asset-published", seeded.id, "accept");
      let errorMessageMatchesNotPending = false;
      try {
        await akmProposalReject({ stashDir: storage.stashDir, id: seeded.id, reason: "must not reject" });
      } catch (err) {
        errorMessageMatchesNotPending = err instanceof Error && /not pending/i.test(err.message);
      }
      return {
        rejectThrewNotPending: errorMessageMatchesNotPending,
        recoveredAcceptStatus: getProposal(storage.stashDir, seeded.id).status,
        assetContentMatchesAccepted: fs.readFileSync(seeded.assetPath, "utf8") === seeded.content,
      };
    })();

    expectGolden(GOLDEN_PATH, {
      scenario: "proposal accept/revert/reject SIGKILL crash recovery outcomes (WI-03, R3, integration scope)",
      capturedAtHead: HEAD_SHA,
      notes: [
        "Crash windows only (brief §3.4) — parameterizes the existing, unmodified " +
          "tests/integration/_helpers/proposal-crash-runner.ts subprocess harness.",
        "journalPhasesObserved is informational only (brief §3.2 rule 4): the single phase name the runner was " +
          "told to hold at, never journal bytes/paths. Chunk 6 replaces the journal engines entirely.",
        "'prepared' rolls back (no partial state survives); every later phase rolls forward via " +
          "recoverProposalTransactions (repository.ts:1310-1355) so all listed phases converge on the same " +
          "final accepted/reverted/rejected outcome with exactly-one event.",
        "The ordering scenario pins that akmProposalReject (proposal.ts:169-186) calls " +
          "recoverProposalTransactionsForStash BEFORE its own pending-status check, so a crashed-but-recoverable " +
          "accept is rolled forward first and the reject then correctly fails as 'not pending' rather than " +
          "racing the interrupted accept.",
      ],
      accept: acceptOutcomes,
      revert: revertOutcomes,
      reject: rejectOutcomes,
      rejectRecoversPendingAccept: orderingOutcome,
    });
  }, 60_000);
});
