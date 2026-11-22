// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression for #908 — `detectAdapterId` now corrects AUTO-DETECTION for a
 * mixed-layout root (a tool-dir/agent-skills layout alongside ordinary akm
 * content detects as `akm`), but that correction cannot see an EXPLICITLY
 * configured adapter (`adapter: "agent-skills"`). Indexing
 * that configuration over the same mixed tree used to silently drop
 * everything outside `agent-skills`' own recognized slice with no warning at
 * all — this pins the ONE-per-process warning that now fires instead, naming
 * the skipped file count and the directory names, and that choosing `akm`
 * itself (the superset) produces no such warning.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { akmIndex } from "../../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

const MIXED_ROOT = path.resolve(__dirname, "../../fixtures/bundles/agent-skills-mixed");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  _resetWarnOnceForTests();
});

afterEach(() => {
  storage.cleanup();
  _resetWarnOnceForTests();
});

function configureMixedBundle(adapter: string): void {
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      mixed: { path: MIXED_ROOT, adapter },
    },
    defaultBundle: "mixed",
  });
  resetConfigCache();
}

describe("indexer — adapter-skips-akm-content warning (#908)", () => {
  test("an explicit `agent-skills` adapter over the mixed tree warns once with the count and directories", async () => {
    configureMixedBundle("agent-skills");

    const warnCalls: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level !== "warn") return;
      warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });

    await akmIndex({ stashDir: MIXED_ROOT, full: true });

    // RED on old code: this warning did not exist at all — a bundle indexed
    // under an explicit `agent-skills` adapter silently dropped knowledge/,
    // content/, workflows/, scripts/, workspace/ with zero disclosure.
    const skipWarning = warnCalls.find((m) => m.includes("agent-skills adapter skipped"));
    expect(skipWarning).toBeDefined();
    expect(skipWarning).toContain("5 files");
    for (const dir of ["knowledge/", "content/", "workflows/", "scripts/", "workspace/"]) {
      expect(skipWarning).toContain(dir);
    }

    // One message for the whole run, not one per directory.
    expect(warnCalls.filter((m) => m.includes("adapter skipped")).length).toBe(1);
  });

  test("choosing `akm` over the same mixed tree produces no skip warning", async () => {
    configureMixedBundle("akm");

    const warnCalls: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level !== "warn") return;
      warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });

    await akmIndex({ stashDir: MIXED_ROOT, full: true });

    expect(warnCalls.some((m) => m.includes("adapter skipped"))).toBe(false);
  });
});
