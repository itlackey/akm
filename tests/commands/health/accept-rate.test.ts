// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 0.9.0 CLI overhaul (S3): `computeAcceptRateBySource` folds the removed
 * `akm history --accept-rate-by-source` flag (F-4 / #385) into `akm health
 * --report`. This pins the aggregation logic directly against the proposal
 * repository, independent of the CLI wiring (covered end-to-end in
 * tests/integration/html-output-cli.test.ts's "akm health --report" describe
 * block).
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeAcceptRateBySource } from "../../../src/commands/health/accept-rate";
import { archiveProposal, createProposal, isProposalSkipped } from "../../../src/commands/proposal/repository";

const VALID_LESSON = (slug: string) =>
  `---\ndescription: Accept-rate fixture lesson for ${slug}\nwhen_to_use: Testing accept-rate aggregation\n---\n\nBody.\n`;

const tempDirs: string[] = [];

function makeStashDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-accept-rate-"));
  tempDirs.push(dir);
  for (const sub of ["lessons", "skills", "memories"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedProposal(stash: string, ref: string, source: string) {
  const created = createProposal(stash, {
    ref,
    source,
    force: true,
    payload: { content: VALID_LESSON(ref) },
  });
  if (isProposalSkipped(created)) throw new Error(`unexpected skip seeding ${ref}`);
  return created;
}

describe("computeAcceptRateBySource", () => {
  test("aggregates accepted/rejected/pending proposals per source", () => {
    const stash = makeStashDir();

    const d1 = seedProposal(stash, "lessons/d1", "distill");
    const d2 = seedProposal(stash, "lessons/d2", "distill");
    archiveProposal(stash, d1.id, "accepted", undefined);
    archiveProposal(stash, d2.id, "rejected", undefined);

    seedProposal(stash, "lessons/r1", "reflect");

    const result = computeAcceptRateBySource(stash);

    const distill = result.find((r) => r.source === "distill");
    expect(distill).toEqual({ source: "distill", total: 2, accepted: 1, rejected: 1, pending: 0, acceptRate: 0.5 });

    const reflect = result.find((r) => r.source === "reflect");
    expect(reflect).toEqual({ source: "reflect", total: 1, accepted: 0, rejected: 0, pending: 1, acceptRate: null });
  });

  test("most-active source sorts first", () => {
    const stash = makeStashDir();
    seedProposal(stash, "lessons/alpha", "reflect");
    const b1 = seedProposal(stash, "lessons/b1", "distill");
    const b2 = seedProposal(stash, "lessons/b2", "distill");
    archiveProposal(stash, b1.id, "accepted", undefined);
    archiveProposal(stash, b2.id, "accepted", undefined);

    const result = computeAcceptRateBySource(stash);
    expect(result[0]?.source).toBe("distill");
    expect(result[0]?.total).toBe(2);
  });

  test("returns an empty array when no proposals exist", () => {
    const stash = makeStashDir();
    expect(computeAcceptRateBySource(stash)).toEqual([]);
  });

  test("a stale-target auto-reject is excluded from rejected/total; an ordinary rejection is counted (STALE, R20)", () => {
    const stash = makeStashDir();

    const stale = seedProposal(stash, "lessons/stale", "distill");
    archiveProposal(stash, stale.id, "rejected", "stale-target: target changed after mint", undefined, {
      outcome: "auto-rejected",
      reason: "stale-target",
      gate: "triage:personal-stash",
    });

    const ordinary = seedProposal(stash, "lessons/ordinary", "distill");
    archiveProposal(stash, ordinary.id, "rejected", "not a real improvement");

    const result = computeAcceptRateBySource(stash);
    const distill = result.find((r) => r.source === "distill");
    expect(distill).toEqual({ source: "distill", total: 1, accepted: 0, rejected: 1, pending: 0, acceptRate: 0 });
  });
});
