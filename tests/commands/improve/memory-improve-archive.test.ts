// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * alpha.9: `archiveCleanupCandidate` generalized to cover any memory,
 * knowledge or lesson file (not only `.derived` memories), for `akm proposal
 * accept` on a consolidate pair-pass `retire` proposal or an O1 promotion
 * retirement — plus `derivedTwinPath`, which locates the `.derived` twin
 * those callers take along. Memory cleanup's own family-prune usage must
 * stay byte-identical (its `previousBeliefState` inference, its tombstone
 * shape without the new fields).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveCleanupCandidate, derivedTwinPath } from "../../../src/commands/improve/memory/memory-improve";
import type { MemoryPruneCandidate } from "../../../src/core/improve-types";

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-archive-candidate-"));
  return dir;
}

function writeAsset(stashDir: string, relPath: string, frontmatter: string, body = "Body text.\n"): string {
  const filePath = path.join(stashDir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`, "utf8");
  return filePath;
}

describe("archiveCleanupCandidate — generalized for retire proposals (alpha.9)", () => {
  test("a retire candidate (proposalId set) reads previousBeliefState from the file's ACTUAL frontmatter", () => {
    const stashDir = sandbox();
    const filePath = writeAsset(stashDir, "memories/old-note.md", "beliefState: superseded\ndescription: old");
    const candidate: MemoryPruneCandidate = {
      ref: "memories/old-note",
      reason: "duplicate",
      proposalId: "proposal-1",
      successorRefs: ["memories/new-note"],
    };
    const record = archiveCleanupCandidate(stashDir, candidate, filePath);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(record.reason).toBe("duplicate");
    expect(record.proposalId).toBe("proposal-1");
    expect(record.successorRefs).toEqual(["memories/new-note"]);
    expect(record.retiredAt).toBe(record.archivedAt);
    // Read from frontmatter, not inferred from `reason` (which under the OLD
    // inference would have produced "active" for anything but
    // "superseded-derived").
    expect(record.previousBeliefState).toBe("superseded");
    expect(record.parentRef).toBeUndefined();

    const tombstone = fs.readFileSync(path.join(stashDir, record.auditPath), "utf8");
    expect(tombstone).toContain("proposalId: proposal-1");
    expect(tombstone).toContain("successorRefs:");
    expect(tombstone).toContain("retiredAt:");
    expect(tombstone).toContain("previousBeliefState: superseded");
  });

  test("a retire candidate with no beliefState in frontmatter defaults to active, same as memory cleanup's resolver", () => {
    const stashDir = sandbox();
    const filePath = writeAsset(stashDir, "knowledge/dup.md", "description: a duplicate knowledge asset");
    const record = archiveCleanupCandidate(
      stashDir,
      { ref: "knowledge/dup", reason: "subsumed", proposalId: "p2", successorRefs: ["knowledge/keeper"] },
      filePath,
    );
    expect(record.previousBeliefState).toBe("active");
  });

  test("memory cleanup's own family-prune usage is unchanged: reason-based inference, no proposalId/successorRefs on the tombstone", () => {
    const stashDir = sandbox();
    // Actual frontmatter says "active", but the OLD inference for
    // superseded-derived must still win — proving this path was not
    // switched over to reading the real frontmatter value.
    const filePath = writeAsset(stashDir, "memories/child.derived.md", "beliefState: active");
    const candidate: MemoryPruneCandidate = {
      ref: "memory:child.derived",
      parentRef: "memories/child",
      reason: "superseded-derived",
      survivorRef: "memory:child.derived.v2",
    };
    const record = archiveCleanupCandidate(stashDir, candidate, filePath);
    expect(record.previousBeliefState).toBe("superseded");
    expect(record.parentRef).toBe("memories/child");
    expect(record.survivorRef).toBe("memory:child.derived.v2");
    expect(record.proposalId).toBeUndefined();
    expect(record.successorRefs).toBeUndefined();
    expect(record.retiredAt).toBeUndefined();

    const tombstone = fs.readFileSync(path.join(stashDir, record.auditPath), "utf8");
    expect(tombstone).not.toContain("proposalId:");
    expect(tombstone).not.toContain("successorRefs:");
    expect(tombstone).not.toContain("retiredAt:");
  });
});

describe("derivedTwinPath", () => {
  test("finds the <name>.derived.md sibling when it exists", () => {
    const stashDir = sandbox();
    const parentPath = writeAsset(stashDir, "memories/foo.md", "description: parent");
    const twinPath = writeAsset(stashDir, "memories/foo.derived.md", "description: derived child");
    expect(derivedTwinPath(parentPath, "memory")).toBe(twinPath);
  });

  test("returns undefined when no twin exists on disk", () => {
    const stashDir = sandbox();
    const parentPath = writeAsset(stashDir, "memories/lonely.md", "description: no child");
    expect(derivedTwinPath(parentPath, "memory")).toBeUndefined();
  });

  test("returns undefined for a non-memory type, and for an already-derived memory", () => {
    const stashDir = sandbox();
    const knowledgePath = writeAsset(stashDir, "knowledge/guide.md", "description: guide");
    expect(derivedTwinPath(knowledgePath, "knowledge")).toBeUndefined();

    const derivedPath = writeAsset(stashDir, "memories/bar.derived.md", "description: already derived");
    expect(derivedTwinPath(derivedPath, "memory")).toBeUndefined();
  });
});
