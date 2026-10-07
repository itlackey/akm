// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A strict structured-output provider needs every property of the plan's
 * promote op in `required`, so the model says "none" in the value: an empty
 * `description` keeps the memory's own, a null `confidence` is no confidence.
 * `emitPromotionProposal` must read both as absent, not carry "" into the
 * proposal's frontmatter or reject a null where it expects a number.
 *
 * Integration (ORG-03): `emitPromotionProposal` mints into a real state.db.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type ConsolidatePromoteOp, emitPromotionProposal } from "../../../../src/commands/improve/consolidate";
import { listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { resolveWriteTarget } from "../../../../src/core/write-source";
import { makeConfig } from "../../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const BODY =
  "Always run the release check on a clean checkout before tagging, because a dirty tree hides files the build needs. " +
  "The second sentence keeps this fixture above the promotion size gate.";

let storage: IsolatedAkmStorage;
let stash: string;
let config: AkmConfig;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = storage.stashDir;
  config = { ...makeConfig(stash), semanticSearchMode: "off" } as AkmConfig;
  fs.mkdirSync(path.join(stash, "memories"), { recursive: true });
  fs.mkdirSync(path.join(stash, "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(stash, "memories", "release-check.md"),
    `---\ndescription: Run the release check on a clean checkout.\n---\n\n${BODY}\n`,
    "utf8",
  );
});

afterEach(() => storage.cleanup());

/** Mint the promotion of `memories/release-check` for `reply` and return the one pending proposal. */
async function promote(reply: Pick<ConsolidatePromoteOp, "description" | "confidence">) {
  const op: ConsolidatePromoteOp = {
    op: "promote",
    ref: "memories/release-check",
    knowledgeRef: "knowledge/release-check",
    reason: "Stable, reusable guidance.",
    ...reply,
  };
  const skips: string[] = [];
  await emitPromotionProposal(op, {
    config,
    stashDir: stash,
    sourceRun: "consolidate-test",
    target: resolveWriteTarget(config),
    memoryByRef: new Map([
      [
        op.ref,
        {
          name: "release-check",
          filePath: path.join(stash, "memories", "release-check.md"),
          description: "Run the release check on a clean checkout.",
          tags: [],
          stashDir: stash,
        },
      ],
    ]),
    promoted: [],
    promotedSourceRefs: new Set(),
    existingKnowledgeBodyHashes: new Set(),
    promotionFailures: { count: 0 },
    warnings: [],
    pushSkipReason: (_op, _ref, reason) => skips.push(reason),
  });
  expect(skips).toEqual([]);
  const pending = listProposals(stash, { status: "pending" });
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

describe("a promote op as a strict provider must write it", () => {
  test("an empty description keeps the memory's own and a null confidence records none", async () => {
    const proposal = await promote({ description: "", confidence: null });
    expect(proposal.payload.frontmatter?.description).toBe("Run the release check on a clean checkout.");
    expect(proposal.payload.content).toContain("description: Run the release check on a clean checkout.");
    expect(proposal).not.toHaveProperty("confidence");
  });

  test("a description and a confidence the model gave are used", async () => {
    const proposal = await promote({ description: "Run the release check before tagging.", confidence: 0.9 });
    expect(proposal.payload.frontmatter?.description).toBe("Run the release check before tagging.");
    expect(proposal.confidence).toBe(0.9);
  });
});
