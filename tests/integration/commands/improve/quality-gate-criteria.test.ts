// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * JUDGE / R16 — per-criterion judge scores must reach both the
 * `distill_invoked` quality-rejection event and the on-disk rejection
 * envelope frontmatter that `writeQualityRejection` writes, not just the
 * in-process return value. Reads the event back via `readEvents`, which opens
 * a real state.db — integration, not a pure unit test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { writeQualityRejection } from "../../../../src/commands/improve/distill/quality-gate";
import { readEvents } from "../../../../src/core/events";
import { getDistillRejectedDir } from "../../../../src/core/paths";
import { makeSandboxDir } from "../../../_helpers/sandbox";

let stashDir: string;
let cleanup: () => void;

beforeEach(() => {
  const sandbox = makeSandboxDir("akm-quality-gate-criteria");
  stashDir = sandbox.dir;
  cleanup = sandbox.cleanup;
});

afterEach(() => cleanup());

describe("writeQualityRejection — per-criterion scores (R16)", () => {
  test("criteria land in the distill_invoked event metadata and the envelope frontmatter", () => {
    const criteria = { novelty: 2, actionability: 3, nonRedundancy: 2 };
    const result = writeQualityRejection(
      stashDir,
      "memories/source-ref",
      "lessons/proposed-ref",
      "proposed lesson body",
      (criteria.novelty + criteria.actionability + criteria.nonRedundancy) / 3,
      "judge reason",
      { criteria },
    );

    expect(result.outcome).toBe("quality_rejected");
    expect((result as unknown as { criteria?: Record<string, number> }).criteria).toEqual(criteria);

    const rows = readEvents().events.filter((e) => e.eventType === "distill_invoked");
    expect(rows.length).toBeGreaterThan(0);
    const metadata = rows[rows.length - 1]?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.criteria).toEqual(criteria);

    const rejectDir = getDistillRejectedDir(stashDir);
    const files = fs.readdirSync(rejectDir);
    expect(files).toHaveLength(1);
    const envelope = fs.readFileSync(path.join(rejectDir, files[0] as string), "utf8");
    expect(envelope).toContain("criteria:");
    expect(envelope).toContain("novelty: 2");
    expect(envelope).toContain("actionability: 3");
    expect(envelope).toContain("nonRedundancy: 2");
  });

  test("no criteria supplied (structural/fidelity rejection) omits the criteria block", () => {
    const result = writeQualityRejection(
      stashDir,
      "memories/source-ref",
      "lessons/proposed-ref-no-criteria",
      "proposed lesson body",
      2.0,
      "structural finding",
      {},
    );
    expect((result as unknown as { criteria?: unknown }).criteria).toBeUndefined();

    const rejectDir = getDistillRejectedDir(stashDir);
    const file = fs.readdirSync(rejectDir).find((f) => f.includes("proposed-ref-no-criteria"));
    expect(file).toBeDefined();
    const envelope = fs.readFileSync(path.join(rejectDir, file as string), "utf8");
    expect(envelope).not.toContain("criteria:");
  });
});

describe("writeQualityRejection — r2-1: mint-time canonical validator rejection is not fatal", () => {
  test("structurally-invalid quality_rejected content returns a normal result with no proposalId, still writes the envelope and event, and does not throw", () => {
    // No `description`/`when_to_use` frontmatter — the mint-time canonical
    // validator (proposal/repository.ts rejectProposal) throws UsageError for
    // this. writeQualityRejection must swallow that throw: the proposal row
    // is bookkeeping for backoff/Reflexion, never the authoritative record of
    // the rejection.
    const result = writeQualityRejection(
      stashDir,
      "memories/source-ref",
      "lessons/proposed-ref-invalid-structure",
      "body with no description or when_to_use frontmatter",
      2.0,
      "structural finding",
      {},
    );

    expect(result.outcome).toBe("quality_rejected");
    expect((result as unknown as { proposalId?: string }).proposalId).toBeUndefined();

    const rows = readEvents().events.filter((e) => e.eventType === "distill_invoked");
    expect(rows.length).toBeGreaterThan(0);
    const metadata = rows[rows.length - 1]?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.outcome).toBe("quality_rejected");

    const rejectDir = getDistillRejectedDir(stashDir);
    const file = fs.readdirSync(rejectDir).find((f) => f.includes("proposed-ref-invalid-structure"));
    expect(file).toBeDefined();
  });
});
