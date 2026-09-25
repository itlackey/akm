// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * itlackey/akm#889: the `stash-dead-residue` health advisory must name every
 * Tier-1 dead pre-0.9.0 `.akm/*` path that still exists on disk, with its
 * size, and never delete anything itself. `removeDeadResidue` is the
 * separate opt-in action (`akm health --clean-dead-residue`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDeadResidueEntries, removeDeadResidue } from "../../scripts/akm-migrate/migrate/dead-residue";
import { sandboxXdgDataHome, sandboxXdgStateHome } from "../_helpers/sandbox";

let stashDir: string;

beforeEach(() => {
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-dead-residue-"));
});

afterEach(() => {
  fs.rmSync(stashDir, { recursive: true, force: true });
});

describe("migrate dead-residue detection and removal (#889)", () => {
  test("reports nothing when .akm does not exist", () => {
    expect(findDeadResidueEntries(stashDir)).toEqual([]);
    expect(findDeadResidueEntries(stashDir)).toEqual([]);
  });

  test("reports nothing when .akm exists but has none of the dead paths", () => {
    fs.mkdirSync(path.join(stashDir, ".akm", "memory-cleanup"), { recursive: true });
    expect(findDeadResidueEntries(stashDir)).toEqual([]);
    expect(findDeadResidueEntries(stashDir)).toEqual([]);
  });

  test("finds each known dead path, including the timestamp-suffixed runs.archived-* directory", () => {
    const akmDir = path.join(stashDir, ".akm");
    fs.mkdirSync(path.join(akmDir, "proposals", "uuid-1"), { recursive: true });
    fs.writeFileSync(path.join(akmDir, "proposals", "uuid-1", "proposal.json"), "{}");
    fs.mkdirSync(path.join(akmDir, "runs.archived-2026-05-24T00-00-00"), { recursive: true });
    fs.writeFileSync(path.join(akmDir, "graph.json"), "{}");
    fs.writeFileSync(path.join(akmDir, "proposals.db"), "");
    // memory-cleanup is a Tier-3 keeper, not a dead-residue path — must never be reported.
    fs.mkdirSync(path.join(akmDir, "memory-cleanup"), { recursive: true });

    const entries = findDeadResidueEntries(stashDir);
    const relPaths = entries.map((e) => e.relativePath).sort();
    expect(relPaths).toEqual(
      [
        path.join(".akm", "proposals"),
        path.join(".akm", "runs.archived-2026-05-24T00-00-00"),
        path.join(".akm", "graph.json"),
        path.join(".akm", "proposals.db"),
      ].sort(),
    );

    const proposalsEntry = entries.find((e) => e.relativePath === path.join(".akm", "proposals"));
    expect(proposalsEntry?.sizeBytes).toBe(2); // "{}"
  });
});

describe("removeDeadResidue (#889)", () => {
  test("deletes only the dead-residue paths and leaves everything else untouched", () => {
    const akmDir = path.join(stashDir, ".akm");
    fs.mkdirSync(path.join(akmDir, "archive"), { recursive: true });
    fs.writeFileSync(path.join(akmDir, "archive", "old.md"), "stale");
    fs.mkdirSync(path.join(akmDir, "memory-cleanup", "archive"), { recursive: true });
    fs.writeFileSync(path.join(akmDir, "memory-cleanup", "belief-transitions.jsonl"), "keep-me");

    const removals = removeDeadResidue(stashDir);
    expect(removals).toHaveLength(1);
    expect(removals[0]?.relativePath).toBe(path.join(".akm", "archive"));
    expect(removals[0]?.removed).toBe(true);

    expect(fs.existsSync(path.join(akmDir, "archive"))).toBe(false);
    expect(fs.existsSync(path.join(akmDir, "memory-cleanup", "belief-transitions.jsonl"))).toBe(true);
    expect(findDeadResidueEntries(stashDir)).toEqual([]);
  });

  test("is a no-op when nothing dead is present", () => {
    expect(removeDeadResidue(stashDir)).toEqual([]);
  });
});

describe("host residue left by machinery removed in 0.9.17", () => {
  test("lists the $DATA activity registry once, plus each lock's mutex sidecar and the reconcile stamp", () => {
    const data = sandboxXdgDataHome();
    const state = sandboxXdgStateHome();
    try {
      const dataDir = path.join(data.dir, "akm");
      const registry = path.join(dataDir, "maintenance-activities");
      fs.mkdirSync(registry, { recursive: true });
      for (let index = 0; index < 25; index += 1) {
        fs.writeFileSync(path.join(registry, `.state-db-${index}-uuid.lock.operations.sensitive`), Buffer.alloc(4096));
      }
      fs.writeFileSync(path.join(registry, "state-db-1-uuid.lock"), '{"pid":1}');
      fs.writeFileSync(path.join(dataDir, ".akm.lock.lck.operations.sensitive"), Buffer.alloc(4096));
      const stateDir = path.join(state.dir, "akm");
      fs.mkdirSync(path.join(stateDir, "locks"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "version-reconcile.json"), "{}");
      fs.writeFileSync(
        path.join(stateDir, "locks", ".version-reconcile.lock.operations.sensitive"),
        Buffer.alloc(4096),
      );

      const entries = findDeadResidueEntries(undefined);
      expect(entries.map((entry) => entry.absolutePath).sort()).toEqual(
        [
          registry,
          path.join(dataDir, ".akm.lock.lck.operations.sensitive"),
          path.join(stateDir, "version-reconcile.json"),
          path.join(stateDir, "locks", ".version-reconcile.lock.operations.sensitive"),
        ].sort(),
      );
      // The registry is one entry; its sidecars are never listed one by one.
      expect(entries.find((entry) => entry.absolutePath === registry)?.sizeBytes).toBe(25 * 4096 + 9);

      const removals = removeDeadResidue(undefined);
      expect(removals).toHaveLength(4);
      expect(removals.every((removal) => removal.removed)).toBe(true);
      expect(fs.existsSync(registry)).toBe(false);
      expect(findDeadResidueEntries(undefined)).toEqual([]);
    } finally {
      state.cleanup();
      data.cleanup();
    }
  });
});
