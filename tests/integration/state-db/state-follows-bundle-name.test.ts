// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * State follows a bundle by its name (§0.2 P8, N10): the proposals, improve-ledger rows and improve runs of a bundle are
 * filed under its config name, so they stay with it when its directory moves; a bundle renamed by hand in config leaves
 * them under the old name, where `akm doctor` reports them (`state-unknown-bundle`), and naming it back reattaches them.
 * `akm bundle rename` carries them (tests/integration/bundle-rename.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createProposal, listProposals } from "../../../src/commands/proposal/repository";
import { stateBundleId } from "../../../src/core/bundle-at-dir";
import { resetConfigCache } from "../../../src/core/config/config";
import { openStateDatabase } from "../../../src/core/state-db";
import {
  listImproveLedgerRows,
  recordImproveLedger,
} from "../../../src/storage/repositories/improve-ledger-repository";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let home: string;

const NOTE = "---\ndescription: Use ripgrep\nwhen_to_use: Searching repos\n---\n\nPrefer rg.\n";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  home = path.join(storage.root, "library");
  fs.mkdirSync(path.join(home, "lessons"), { recursive: true });
  configure({ work: home });
});

afterEach(() => {
  storage.cleanup();
  resetConfigCache();
});

/** The config: each bundle name at its directory, the first one the default. */
function configure(bundles: Record<string, string>): void {
  const [first] = Object.keys(bundles);
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: Object.fromEntries(Object.entries(bundles).map(([name, dir]) => [name, { path: dir, writable: true }])),
    defaultBundle: first,
    defaultWriteTarget: first,
  });
  resetConfigCache();
}

function seedState(dir: string, bundle: string): string {
  const proposal = createProposal(dir, {
    ref: "lessons/rg",
    source: "reflect",
    target: { source: bundle, root: dir },
    payload: { content: NOTE },
  });
  const db = openStateDatabase();
  try {
    recordImproveLedger(db, {
      bundleId: stateBundleId(dir),
      ref: `${bundle}//lessons/other`,
      source: "reflect",
      outcome: "rejected",
      at: "2026-10-01T00:00:00.000Z",
    });
  } finally {
    db.close();
  }
  return proposal.id;
}

const ledgerRefs = (dir: string): string[] => {
  const db = openStateDatabase();
  try {
    return listImproveLedgerRows(db, stateBundleId(dir)).map((row) => row.ref);
  } finally {
    db.close();
  }
};

describe("state rows follow the bundle's name", () => {
  test("a bundle whose directory moved keeps its proposals and ledger", () => {
    const id = seedState(home, "work");
    expect(listProposals(home).map((p) => p.id)).toEqual([id]);

    const moved = path.join(storage.root, "elsewhere", "renamed-directory");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(home, moved);
    configure({ work: moved });

    expect(stateBundleId(moved)).toBe("work");
    expect(listProposals(moved).map((p) => p.id)).toEqual([id]);
    expect(ledgerRefs(moved)).toEqual(["work//lessons/other", "work//lessons/rg"]);
  });

  test("a bundle renamed by hand in config is detached, and naming it back reattaches it", async () => {
    const id = seedState(home, "work");
    configure({ renamed: home });

    expect(stateBundleId(home)).toBe("renamed");
    expect(listProposals(home)).toEqual([]);
    expect(ledgerRefs(home)).toEqual([]);

    const report = JSON.parse((await runCliCapture(["doctor", "--no-probe", "--format", "json"])).stdout) as {
      advisories: Array<{
        name: string;
        status: string;
        message: string;
        evidence?: { bundles: Array<{ id: string; kind: string; rows: Record<string, number> }> };
      }>;
    };
    const finding = report.advisories.find((entry) => entry.name === "state-unknown-bundle");
    expect(finding?.status).toBe("pass");
    expect(finding?.evidence?.bundles).toEqual([
      { id: "work", kind: "name", rows: { proposals: 1, improve_ledger: 2 } },
    ]);
    expect(finding?.message).toContain('bundle "work" (1 in proposals, 2 in improve_ledger)');

    configure({ work: home });
    expect(listProposals(home).map((p) => p.id)).toEqual([id]);
  }, 60_000);

  test("`akm doctor` has no `state-unknown-bundle` entry when every row names a bundle", async () => {
    seedState(home, "work");
    const report = JSON.parse((await runCliCapture(["doctor", "--no-probe", "--format", "json"])).stdout) as {
      advisories: Array<{ name: string }>;
    };
    expect(report.advisories.some((entry) => entry.name === "state-unknown-bundle")).toBe(false);
  }, 60_000);

  test("two bundles keep separate queues", () => {
    const team = path.join(storage.root, "team");
    fs.mkdirSync(path.join(team, "lessons"), { recursive: true });
    configure({ work: home, team });
    const workId = seedState(home, "work");
    const teamId = seedState(team, "team");

    expect(listProposals(home).map((p) => p.id)).toEqual([workId]);
    expect(listProposals(team).map((p) => p.id)).toEqual([teamId]);
    expect(ledgerRefs(team)).toEqual(["team//lessons/other", "team//lessons/rg"]);
  });
});
