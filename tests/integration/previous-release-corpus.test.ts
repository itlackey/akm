// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Previous-release upgrade-smoothness guard rail.
 *
 * POLICY: a schema bump (task source v2/v3/v4, the proposals `metadata_json`
 * envelope, or anything else a prior release wrote to disk/state.db) must
 * have an explicit upgrade path backed by real-shaped fixtures. Persisted
 * state normally remains read-compatible. Task source is the deliberate
 * exception (#987): the runtime reads only task source v4, and refuses each
 * older file on its own, naming `akm migrate apply`, which owns the
 * deterministic v2/v3 -> v4 rewrite and removal of v4 source enablement.
 *
 * Every fixture below is a REAL-SHAPED artifact from a prior release — not a
 * synthetic minimal case. When a future schema bump lands, add the OLD shape
 * here BEFORE shipping. If this suite fails, an upgrade break was about to
 * ship: either restore read compatibility (preferred — add/extend the
 * auto-shim) or, if the break is genuinely intentional, delete the fixture
 * here in the SAME change that removes support for it, with the reason
 * spelled out in the commit message.
 *
 * Current coverage:
 *   - task source v2, v3 and v4-with-`schedule[].enabled` (`fixtures/task-v*.yml`)
 *     — refused at runtime naming the 0.9.32 recipe; 0.10 converts none of
 *     them (the floor).
 *   - pre-envelope proposal rows (`metadata_json` missing `changes`,
 *     `proposedTarget`, `beforeHash`, `eligibilitySource`, `backupContent` —
 *     the REAL shape pulled from a live 24,358-row archive during the #859
 *     reopening, not a single deleted key) — read via `listStateProposals`,
 *     which decodes each absent field as omitted rather than failing the row
 *     or the whole list (`src/storage/repositories/proposals-repository.ts`).
 *     #859 was reopened because the 0.9.4 fix, verified only against a
 *     synthetic single-field fixture, still broke on the real archive's next
 *     missing field — this fixture is the guard rail against that recurring.
 *   - pre-`metadataVersion` `task_history` rows (no `metadataVersion` at all,
 *     58% of a real install's rows; and rows carrying the additive
 *     `profile`/`repairReason` fields two prior releases wrote, 88 more real
 *     rows) — read via `readTaskHistory()` (the `akm task history` path) and
 *     `akmHealth()` (the `akm health --report` path), which decode the
 *     legacy/additive shapes instead of throwing
 *     (`src/storage/repositories/task-history-repository.ts`'s
 *     `decodeTaskHistoryMetadata`).
 *   - the `AKM_BUNDLE_DIR`-synthesized duplicate `stash` bundle entry
 *     (#870) — read via `scripts/akm-migrate/bundle-roots.ts`'s `bundleRoots`,
 *     which reconciles two bundle ids resolving to the same content root
 *     instead of double-enumerating and throwing `duplicate task migration
 *     file path`.
 *   - a real-shaped 0.8 config carrying the retired `stashDir`/`sources[]`/
 *     `installed[]` trio together (#863) — below the 0.9.15 floor (#1091):
 *     refused with a message naming `akm migrate apply` under akm 0.9.x.
 *   - downstream-consumer fixtures for OpenPalm (a real, if unofficial,
 *     integration point, #880): a `config.json` `bundles` shape and four
 *     task source v4 files exercising its grammar (`run:`/`shell:`,
 *     `uses:`/`with:`, `timeout:`, optional `schedule:`) — static files
 *     proving akm doesn't tighten its schema in a way that breaks a real
 *     consumer.
 *   - a v22 derived index carrying a LIVE embedding (`index-v22-with-
 *     embedding.sql`) — the writable opener (`ensureSchema`,
 *     `index-schema.ts`) migrates it in place, keeping the entry and its
 *     vector (labelled with the model it was generated under), so the next
 *     embedding pass (`generateEmbeddingsForDb`) makes zero provider calls.
 *   - a layout-25 derived index as 0.9.17-alpha.7 wrote it (`index-v25.sql`),
 *     whose relations sat only in `document_json` — a reader serves it as-is,
 *     and the writable opener derives its declared links (#935) in place,
 *     re-reading only the directories that hold workflows and tasks.
 *   - a layout-20 derived index as 0.9.1 wrote it (`index-v20.sql`), whose
 *     `entries` table keeps the transitional NOT NULL columns layout 21
 *     removed and leaves `document_json` NULL — a reader cannot serve it, and
 *     the writable opener recreates its entries-keyed tables instead of
 *     migrating it in place (#1053), from the pristine file and from the
 *     half-migrated one a failed 0.9.17+ open left behind.
 *   - old crontab rows (akm < 0.9.2, #881, and the `--scheduler-context` rows of
 *     0.9.0 – 0.9.17-alpha.6): akm 0.10 never parses a row. `akm task sync`
 *     finds the `# akm:task … BEGIN/END` sentinels (akm's own proof of
 *     ownership) and replaces every row with the one dispatch entry.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfigFile } from "../../scripts/akm-migrate/config/normalize";
import { inspectEngineKeysMigration } from "../../scripts/akm-migrate/engine-key-migrate";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { akmHealth } from "../../src/commands/health";
import { createProposal as createProposalImpl } from "../../src/commands/proposal/repository";
import { akmTasksSync } from "../../src/commands/tasks/tasks";
import { loadConfig, parseAndValidateConfigText, resetConfigCache, updateConfig } from "../../src/core/config/config";
import { getConfigPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests, resetQuiet, setQuiet } from "../../src/core/warn";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import {
  closeDatabase,
  deleteIndexDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { CANONICAL_INDEX_DB_VERSION, hasCurrentEntriesTable } from "../../src/storage/repositories/index-entry-schema";
import { getMeta } from "../../src/storage/repositories/index-meta-repository";
import { listStateProposals } from "../../src/storage/repositories/proposals-repository";
import { upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { setSchedulerRefEnabled } from "../../src/tasks/activation-config";
import { CRON_BACKEND, type CronExec, type CronExecResult } from "../../src/tasks/backends/cron";
import { readTaskHistory } from "../../src/tasks/run/task-history";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";
import {
  configNamingBundle,
  type IsolatedAkmStorage,
  sandboxStashDir,
  sandboxXdgConfigHome,
  sandboxXdgStateHome,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "fixtures", "previous-release-corpus");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("previous-release corpus — upgrade must not break reads", () => {
  // index.db is derived, so a layout below the floor (26) is rebuilt, not upgraded in place.
  for (const fixture of ["index-v20.sql", "index-v22.sql", "index-v22-with-embedding.sql", "index-v25.sql"]) {
    test(`${fixture}: a reader finds it unservable without failing, and an index deleted for the build opens empty`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-old-index-"));
      try {
        const dbPath = path.join(root, "index.db");
        const legacy = new Database(dbPath);
        legacy.exec(readFixture(fixture));
        legacy.close();

        const reader = openReadonlyExistingDatabase(dbPath);
        if (!reader) throw new Error("expected a read handle");
        try {
          expect(hasCurrentEntriesTable(reader)).toBe(false);
        } finally {
          closeDatabase(reader);
        }

        deleteIndexDatabase(dbPath);

        const rebuilt = openIndexDatabase(dbPath);
        try {
          expect(getMeta(rebuilt, "version")).toBe(String(CANONICAL_INDEX_DB_VERSION));
          expect(hasCurrentEntriesTable(rebuilt)).toBe(true);
          expect(rebuilt.prepare("SELECT COUNT(*) AS count FROM entries").get()).toEqual({ count: 0 });
          expect(rebuilt.prepare("SELECT COUNT(*) AS count FROM embeddings").get()).toEqual({ count: 0 });
          const entry = { type: "knowledge" as const, name: "new-note", description: "Added after the rebuild." };
          upsertEntry(
            rebuilt,
            "/fixture/stash/knowledge/new-note.md",
            entry,
            deriveEntryProvenance(
              { bundleId: "stash", componentId: "stash", adapterId: "akm" },
              entry.type,
              entry.name,
            ),
          );
          expect(rebuilt.prepare("SELECT item_ref FROM entries").all()).toEqual([
            { item_ref: "stash//knowledge/new-note" },
          ]);
        } finally {
          closeDatabase(rebuilt);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  // The runtime reads only task source v4 (#987): each older shape is refused
  // on its own, naming the 0.9.32 recipe (the floor); 0.10 converts none of them.
  function expectRefusedNamingMigrate(yaml: string, filePath: string): void {
    let error: unknown;
    try {
      parseTaskSource({ yaml, filePath });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("akm-cli@0.9.32 && akm migrate apply");
  }

  describe("task source below the 0.9.32 floor (refused at runtime, never converted)", () => {
    for (const fixture of ["task-v2.yml", "task-v3.yml", "task-v2-env-prefixed.yml", "task-v4-schedule-enabled.yml"]) {
      test(`${fixture} is refused naming the 0.9.32 recipe`, () => {
        expectRefusedNamingMigrate(readFixture(fixture), path.join(FIXTURES_DIR, fixture));
      });
    }
  });

  describe("proposals state.db — pre-#858 legacy envelope", () => {
    let storage: IsolatedAkmStorage;

    beforeEach(() => {
      storage = withIsolatedAkmStorage({}, { bundle: false });
    });

    afterEach(() => {
      storage.cleanup();
    });

    // Real `metadata_json` blobs pulled read-only from a 24,358-row live
    // archive during the #859 reopening investigation (content/refs
    // redacted to generic placeholders; shape and key set are verbatim).
    // These are the ACTUAL pre-envelope shape prior releases wrote — not a
    // single deleted key. #859 was reopened specifically because a synthetic
    // fixture missing only `changes` shipped a fix that still broke on the
    // real archive's next missing field (`proposedTarget`, 93% of rows), so
    // this fixture exists to catch exactly that class of gap.
    const REAL_ACCEPTED_NO_ENVELOPE =
      '{"sourceRun":"consolidate-1780479673158","review":{"outcome":"accepted","decidedAt":"2026-06-03T10:07:02.238Z"},"confidence":0.92}';
    const REAL_REJECTED_NO_ENVELOPE =
      '{"sourceRun":"reflect-1778513697852","review":{"outcome":"rejected","reason":"clearing prior improve run proposals before test run","decidedAt":"2026-05-11T20:34:12.500Z"}}';
    const REAL_ACCEPTED_WITH_GATE_NO_TARGET =
      '{"sourceRun":"consolidate-1781322542465","review":{"outcome":"accepted","decidedAt":"2026-06-13T04:04:01.412Z"},"confidence":0.92,"gateDecision":{"outcome":"auto-accepted","reason":"policy-accept","gate":"triage:personal-stash","decidedAt":"2026-06-13T04:04:01.373Z"}}';

    test("real-shaped legacy rows (no changes, proposedTarget, beforeHash, eligibilitySource, or backupContent) are read, not fatal", () => {
      const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-corpus-proposal-"));
      for (const dir of ["lessons"]) fs.mkdirSync(path.join(stash, dir), { recursive: true });
      try {
        const healthy = createProposalImpl(
          stash,
          {
            ref: "lessons/corpus-healthy",
            source: "reflect",
            payload: {
              content:
                "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg over grep.\n",
            },
            target: { source: "stash", root: path.resolve(stash) },
          },
          undefined,
        );

        // Insert real-shaped legacy rows directly (createProposal always
        // mints the full current envelope — it cannot produce these shapes;
        // they only exist on rows a PRIOR release wrote).
        const db = openStateDatabase();
        const legacyIds = {
          accepted: "corpus-legacy-accepted-real-shape",
          rejected: "corpus-legacy-rejected-real-shape",
          acceptedGated: "corpus-legacy-accepted-gated-real-shape",
        };
        try {
          const insert = db.prepare(
            `INSERT INTO proposals
             (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          );
          insert.run(
            legacyIds.accepted,
            path.resolve(stash),
            "akm//knowledge/corpus-legacy-accepted",
            "accepted",
            "consolidate",
            "2026-06-03T10:07:02.000Z",
            "2026-06-03T10:07:02.238Z",
            "legacy accepted content",
            REAL_ACCEPTED_NO_ENVELOPE,
          );
          insert.run(
            legacyIds.rejected,
            path.resolve(stash),
            "akm//commands/corpus-legacy-rejected",
            "rejected",
            "reflect",
            "2026-05-11T20:34:12.000Z",
            "2026-05-11T20:34:12.500Z",
            "legacy rejected content",
            REAL_REJECTED_NO_ENVELOPE,
          );
          insert.run(
            legacyIds.acceptedGated,
            path.resolve(stash),
            "akm//knowledge/corpus-legacy-gated",
            "accepted",
            "consolidate",
            "2026-06-13T04:04:01.000Z",
            "2026-06-13T04:04:01.412Z",
            "legacy gated content",
            REAL_ACCEPTED_WITH_GATE_NO_TARGET,
          );
        } finally {
          db.close();
        }

        const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
        let listed: ReturnType<typeof listStateProposals> = [];
        try {
          const listDb = openStateDatabase();
          try {
            expect(() => {
              listed = listStateProposals(listDb, { stashDir: path.resolve(stash) });
            }).not.toThrow();
          } finally {
            listDb.close();
          }
        } finally {
          warnSpy.mockRestore();
        }

        const byId = new Map(listed.map((p) => [p.id, p]));
        expect(byId.has(healthy.id)).toBe(true);
        // #858/#859 decision: a legacy row (missing the whole pre-envelope
        // shape — changes, proposedTarget, beforeHash, eligibilitySource,
        // backupContent all absent) is a REAL accepted/rejected proposal
        // whose per-file detail was never captured. It must still be
        // listed — because dropping it silently under-counts history (the
        // exact defect #859 documented in improve's outcome-score
        // salience) — with those fields simply omitted, not defaulted to
        // fabricated values.
        for (const id of Object.values(legacyIds)) {
          expect(byId.has(id)).toBe(true);
          const p = byId.get(id);
          expect(p?.changes).toEqual([]);
          expect(p?.proposedTarget).toBeUndefined();
          expect(p?.beforeHash).toBeUndefined();
          expect(p?.eligibilitySource).toBeUndefined();
          expect(p?.backupContent).toBeUndefined();
        }
        // The gated row's gateDecision (present in real data even without
        // proposedTarget) still round-trips.
        expect(byId.get(legacyIds.acceptedGated)?.gateDecision?.outcome).toBe("auto-accepted");
      } finally {
        fs.rmSync(stash, { recursive: true, force: true });
      }
    });
  });

  describe("task_history state.db — legacy metadata_json (no metadataVersion / additive fields)", () => {
    let storage: IsolatedAkmStorage;

    beforeEach(() => {
      storage = withIsolatedAkmStorage({}, { bundle: false });
    });

    afterEach(() => {
      storage.cleanup();
    });

    const baseRow = {
      status: "completed",
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: "2025-01-01T00:00:00.000Z",
      failed_at: null,
      log_path: null,
      target_kind: "shell",
      target_ref: null,
    };

    test("a real-shaped row with no metadataVersion (the 8,508-row live shape) reads via `akm task history` and `akm health --report` without throwing", async () => {
      const db = openStateDatabase();
      try {
        upsertTaskHistory(db, {
          ...baseRow,
          task_id: "corpus-legacy-no-version",
          metadata_json: JSON.stringify({ durationMs: 48557, detail: { exitCode: 0 } }),
        });
      } finally {
        db.close();
      }

      const rows = readTaskHistory({ id: "corpus-legacy-no-version" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.durationMs).toBe(48557);

      await expect(akmHealth({ since: "7d" })).resolves.toBeDefined();
    });

    test("real-shaped rows carrying the additive `profile`/`repairReason` fields (88 live rows) read without throwing", async () => {
      const db = openStateDatabase();
      try {
        upsertTaskHistory(db, {
          ...baseRow,
          task_id: "corpus-legacy-profile",
          metadata_json: JSON.stringify({ durationMs: 1, detail: { exitCode: 0 }, profile: "opencode" }),
        });
        upsertTaskHistory(db, {
          ...baseRow,
          task_id: "corpus-legacy-repair-reason",
          metadata_json: JSON.stringify({
            metadataVersion: 2,
            durationMs: 1,
            detail: { exitCode: 1 },
            repairReason: "manual",
          }),
        });
      } finally {
        db.close();
      }

      expect(readTaskHistory({ id: "corpus-legacy-profile" })).toHaveLength(1);
      expect(readTaskHistory({ id: "corpus-legacy-repair-reason" })).toHaveLength(1);
      await expect(akmHealth({ since: "7d" })).resolves.toBeDefined();
    });
  });
});

// ── AKM_BUNDLE_DIR synthesized "stash" bundle duplicate (#870) ─────────────
//
// #870's root cause: `AKM_BUNDLE_DIR` pointing at a directory already
// configured under a different bundle id (e.g. `openpalm`) registered a
// SECOND bundle for it (auto-named `stash`, promoted to `defaultBundle`) —
// the real shape a broken prior release wrote to a user's `config.json`.
// Fixed by matching registration on the resolved content root
// (`bundleContentRoot`/`bundleKeyForContentRoot` in
// `src/core/config/config-sources.ts`) instead of the bare configured
// `path`. The current architecture rejects aliases at config load because
// source ownership and grants cannot depend on which id a caller used. This
// corpus entry proves the exact old shape fails with actionable identities,
// rather than reaching the former opaque `duplicate task migration file
// path` error.
describe("previous-release corpus — AKM_BUNDLE_DIR duplicate 'stash' bundle (#870)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage({}, { bundle: false });
  });

  afterEach(() => {
    storage.cleanup();
  });

  test("a home with a pre-#870 duplicate 'stash' bundle entry names both aliases and their shared root", () => {
    fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "demo.yml"),
      "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n",
      { mode: 0o640 },
    );
    writeSandboxConfig({
      defaultBundle: "stash",
      bundles: {
        openpalm: { path: storage.stashDir, writable: true },
        stash: { path: storage.stashDir, writable: true },
      },
    });

    expect(() => inspectEngineKeysMigration()).toThrow(/openpalm.*stash.*same physical content root/i);
  });
});

// ── Retired 0.8 source-config keys (`stashDir`/`sources[]`/`installed[]`) ──
//
// These fully predate the 0.9.0 `bundles` + `defaultBundle` shape. They are
// older than the 0.9.15 floor (#1091): 0.10 converts nothing, and a real
// 0.8-era config.json is refused with one message naming `akm migrate apply`
// under akm 0.9.x rather than being silently misread.
describe("previous-release corpus — retired 0.8 source-config keys (below the 0.9.32 floor, #1091)", () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => resetConfigCache());

  test("a real-shaped 0.8 config (stashDir + sources[] + installed[] together) is refused, naming akm migrate apply under akm 0.9.x", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        stashDir: "/home/user/.akm-stash",
        sources: [{ type: "filesystem", path: "/home/user/.akm-stash", name: "primary" }],
        installed: [
          {
            id: "npm:left-pad",
            source: "npm",
            ref: "npm:left-pad",
            stashRoot: "/home/user/.akm-stash/left-pad",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(() => loadConfig()).toThrow(/predates akm 0\.9\.32.*akm-cli@0\.9\.32 && akm migrate apply/);
  });
});

describe("previous-release corpus — a config as 0.9.15/0.9.16 wrote it", () => {
  beforeEach(() => resetConfigCache());
  afterEach(() => resetConfigCache());

  test("bundles + an `engines` block with first-class engine fields + a 0.9.16 {kind, ref, sourceId} scheduler entry load, the entry as its ref and the engines block not read", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultBundle: "stash",
        bundles: { stash: { path: "/home/user/.akm-stash", writable: true } },
        engines: {
          fast: {
            kind: "llm",
            endpoint: "https://example.test/v1/chat/completions",
            model: "test",
            temperature: 0.2,
            reasoningEffort: "low",
          },
        },
        scheduler: {
          enabled: [{ kind: "task", ref: "stash//tasks/nightly", sourceId: `sha256:${"a".repeat(64)}` }],
        },
      }),
    );

    const config = loadConfig();
    expect(config.defaultBundle).toBe("stash");
    // The `engines` block is not converted by a load: `akm migrate apply` does that.
    expect(config.connections ?? {}).toEqual({});
    expect(config.scheduler?.enabled).toEqual(["stash//tasks/nightly"]);
  });
});

describe("previous-release corpus — retired experimental.workflowEngine key", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetConfigCache();
    // The warning is once-per-process; an earlier test loading the same key
    // would otherwise consume it before this describe asserts it.
    _resetWarnOnceForTests();
    setQuiet(false);
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    resetQuiet();
    resetConfigCache();
  });

  test("a real-shaped 0.9.15 config (experimental.workflowEngine alongside improveAutonomy) loads, improveAutonomy is honored, and a one-time warning names the key", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        experimental: { improveAutonomy: true, workflowEngine: true },
      }),
    );

    const config = loadConfig();
    expect(config.experimental?.improveAutonomy).toBe(true);
    const warned = (warnSpy.mock.calls as unknown[][]).some((call) => call.join(" ").includes("workflowEngine"));
    expect(warned).toBe(true);
  });

  test("experimental.workflowEngine alongside a retired top-level key both load, both are dropped, and both are named in the warning (the generalized stripRetiredConfigKeys shim, src/core/config/retired-config-keys-shim.ts)", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        features: { improve: { reflect: { mode: "llm" } } },
        experimental: { improveAutonomy: true, workflowEngine: true },
      }),
    );

    const config = loadConfig();
    expect(config.experimental?.improveAutonomy).toBe(true);

    const messages = (warnSpy.mock.calls as unknown[][]).map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("workflowEngine"))).toBe(true);
    expect(messages.some((m) => m.includes("features"))).toBe(true);
  });

  test("after `akm migrate apply` removes every retired key from config.json, loadConfig emits no retired-keys warning", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        features: { improve: { reflect: { mode: "llm" } } },
        experimental: { improveAutonomy: true, workflowEngine: true },
      }),
    );

    const result = normalizeConfigFile(configPath, { apply: true });
    expect(result.applied).toBe(true);
    expect(result.keys).toEqual(expect.arrayContaining(["experimental", "features"]));

    resetConfigCache();
    _resetWarnOnceForTests();
    warnSpy.mockClear();
    const config = loadConfig();
    expect(config.experimental?.improveAutonomy).toBe(true);
    expect((config as unknown as Record<string, unknown>).features).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("an unknown experimental key is dropped with a warning, never fatal", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        experimental: { improveAutonomyy: true },
      }),
    );

    const _config = loadConfig();
    const messages = (warnSpy.mock.calls as unknown[][]).map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("experimental.improveAutonomyy"))).toBe(true);
  });
});

/** The retired `index` section: no longer in the schema, so a config that still has one carries it as an unknown key. */
function retiredIndexSection(config: object): Record<string, unknown> | undefined {
  return (config as { index?: Record<string, unknown> }).index;
}

describe("previous-release corpus — retired index.graph.lazyGraphExtraction key", () => {
  beforeEach(() => {
    resetConfigCache();
    _resetWarnOnceForTests();
  });

  afterEach(() => {
    _setWarnSinkForTests(undefined);
    resetConfigCache();
  });

  test("a 0.9.17-alpha.5 config that sets it still loads; alpha.9 retiring the whole pass supersedes the old per-field warning, sub-fields stay kept in memory", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        index: { graph: { lazyGraphExtraction: true, graphExtractionBatchSize: 2 } },
      }),
    );
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });

    const config = loadConfig();

    // The whole `index` section is retired, so the unknown-key walk stops at `index` itself: one warning
    // for the section, not one per sub-field.
    expect(warnings.filter((w) => w.includes('Unknown config key "index"'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("lazyGraphExtraction"))).toHaveLength(0);
    const graph = retiredIndexSection(config)?.graph as Record<string, unknown> | undefined;
    expect(graph?.graphExtractionBatchSize).toBe(2);
    expect(graph?.lazyGraphExtraction).toBe(true);
  });
});

describe("previous-release corpus — retired index.graph key (whole pass, 0.9.17-alpha.9)", () => {
  beforeEach(() => {
    resetConfigCache();
    _resetWarnOnceForTests();
  });

  afterEach(() => {
    _setWarnSinkForTests(undefined);
    resetConfigCache();
  });

  test("a config that still sets index.graph loads with exactly one warning naming it", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        index: { graph: { lazyGraphExtraction: true } },
      }),
    );
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });

    const config = loadConfig();

    expect(warnings.filter((w) => w.includes('Unknown config key "index"'))).toHaveLength(1);
    expect((retiredIndexSection(config)?.graph as Record<string, unknown> | undefined)?.lazyGraphExtraction).toBe(true);
  });

  test("index.graph survives an unrelated ordinary config write", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        index: { graph: { lazyGraphExtraction: true } },
      }),
    );

    // A value that clearly differs from the schema default, so the write is
    // not pruned away as a no-op change (unlike e.g. semanticSearchMode:
    // "off", which equals the default and would disappear again — #972).
    updateConfig({ bundles: { extra: { path: "/tmp/extra-bundle" } } });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const index = raw.index as Record<string, unknown> | undefined;
    expect((index?.graph as Record<string, unknown> | undefined)?.lazyGraphExtraction).toBe(true);
    expect((raw.bundles as Record<string, unknown> | undefined)?.extra).toEqual({ path: "/tmp/extra-bundle" });
  });

  test("only `akm migrate apply` drops index.graph from config.json", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        index: { graph: { lazyGraphExtraction: true } },
      }),
    );

    // `akm migrate status` (apply: false) reports the change without writing.
    const status = normalizeConfigFile(configPath, { apply: false });
    expect(status.applied).toBe(false);
    expect(status.keys).toContain("index");
    const stillThere = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const stillIndex = stillThere.index as Record<string, unknown> | undefined;
    expect((stillIndex?.graph as Record<string, unknown> | undefined)?.lazyGraphExtraction).toBe(true);

    // `akm migrate apply` (apply: true) writes the drop.
    const result = normalizeConfigFile(configPath, { apply: true });
    expect(result.applied).toBe(true);
    expect(result.keys).toContain("index");

    const after = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const afterIndex = after.index as Record<string, unknown> | undefined;
    expect(afterIndex?.graph).toBeUndefined();

    resetConfigCache();
    _resetWarnOnceForTests();
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    loadConfig();
    expect(warnings.filter((w) => w.includes("index.graph"))).toHaveLength(0);
  });
});

describe("previous-release corpus — leftover improve.strategies['graph-refresh'] override (0.9.17-alpha.9)", () => {
  beforeEach(() => {
    resetConfigCache();
    _resetWarnOnceForTests();
  });

  afterEach(() => {
    _setWarnSinkForTests(undefined);
    resetConfigCache();
  });

  test("a config with a leftover override for the deleted graph-refresh built-in still loads, unread", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        improve: { strategies: { "graph-refresh": { processes: { graphExtraction: { mode: "llm" } } } } },
      }),
    );

    const config = loadConfig();

    // Schema-valid (any name is a legal custom-strategy key) — it loads and
    // is kept in memory, same as any other config data. It is simply never
    // resolved: resolveImproveStrategy refuses "graph-refresh" unconditionally.
    expect((config.improve?.strategies as Record<string, unknown> | undefined)?.["graph-refresh"]).toEqual({
      processes: { graphExtraction: { mode: "llm" } },
    });
  });

  test("only `akm migrate apply` drops the leftover graph-refresh override from config.json", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        improve: { strategies: { "graph-refresh": { processes: { graphExtraction: { mode: "llm" } } } } },
      }),
    );

    // `akm migrate status` (apply: false) reports the change without writing.
    const status = normalizeConfigFile(configPath, { apply: false });
    expect(status.applied).toBe(false);
    expect(status.keys).toContain("improve");
    const stillThere = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const stillImprove = stillThere.improve as Record<string, unknown> | undefined;
    expect((stillImprove?.strategies as Record<string, unknown> | undefined)?.["graph-refresh"]).toBeDefined();

    // `akm migrate apply` (apply: true) writes the drop.
    const result = normalizeConfigFile(configPath, { apply: true });
    expect(result.applied).toBe(true);
    expect(result.keys).toContain("improve");

    const after = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const afterImprove = after.improve as Record<string, unknown> | undefined;
    expect((afterImprove?.strategies as Record<string, unknown> | undefined)?.["graph-refresh"]).toBeUndefined();
  });

  test("a sibling custom strategy in improve.strategies survives the drop untouched", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        improve: {
          strategies: {
            "graph-refresh": { processes: { graphExtraction: { mode: "llm" } } },
            "my-custom-strategy": { processes: { reflect: { enabled: true } } },
          },
        },
      }),
    );

    normalizeConfigFile(configPath, { apply: true });

    const after = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const afterStrategies = (after.improve as Record<string, unknown> | undefined)?.strategies as
      | Record<string, unknown>
      | undefined;
    expect(afterStrategies?.["graph-refresh"]).toBeUndefined();
    expect(afterStrategies?.["my-custom-strategy"]).toEqual({ processes: { reflect: { enabled: true } } });
  });
});

// ── Downstream consumer: OpenPalm (#880) ────────────────────────────────────
//
// OpenPalm is a real, if unofficial, integration point (see #870/#867's
// issue bodies). These are STATIC fixtures standing in for the shapes its
// `akm-sources.ts` writes and the task source v4 grammar it schedules
// against — copied in to prove akm does not tighten its schema in a way
// that breaks a real downstream consumer. Nothing here wires up live to
// another repo; these are plain files read the same way any other corpus
// fixture is.
describe("previous-release corpus — downstream consumer: OpenPalm (#880)", () => {
  const OPENPALM_DIR = path.join(FIXTURES_DIR, "openpalm-consumer");

  test("OpenPalm's config.json shape (bundles + one-component-per-bundle) parses without throwing", () => {
    const text = fs.readFileSync(path.join(OPENPALM_DIR, "config.json"), "utf8");
    let config: ReturnType<typeof parseAndValidateConfigText> | undefined;
    expect(() => {
      config = parseAndValidateConfigText(text);
    }).not.toThrow();
    expect(config?.defaultBundle).toBe("openpalm");
    expect(config?.bundles?.openpalm?.path).toBe("/srv/openpalm/stash");
  });

  test("OpenPalm's `uses:`/`with:` task source v4 file (builtin command target) parses without throwing", () => {
    const filePath = path.join(OPENPALM_DIR, "reddit-leads-ingest.yml");
    const result = parseTaskSource({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
    expect(result.version).toBe(4);
    expect(result.v4.target.kind).toBe("uses");
    expect(result.v4.execution.timeout).toBe(120000);
    expect(result.v4.manualOnly).toBe(false);
  });

  test("OpenPalm's `run:`/`shell:` task source v4 file (scheduled) parses without throwing", () => {
    const filePath = path.join(OPENPALM_DIR, "discord-wiki-articles-ingest.yml");
    const result = parseTaskSource({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
    expect(result.version).toBe(4);
    expect(result.v4.target.kind).toBe("run");
    expect(result.v4.execution.timeout).toBe(300000);
  });

  test("OpenPalm's `uses:` task source v4 file with no `timeout:` and no top-level `enabled:` parses without throwing", () => {
    const filePath = path.join(OPENPALM_DIR, "health-report.yml");
    const result = parseTaskSource({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
    expect(result.version).toBe(4);
    expect(result.v4.target.kind).toBe("uses");
    expect(result.v4.execution.timeout).toBeUndefined();
  });

  test("OpenPalm's manual (unscheduled) `run:`/`shell:` task source v4 file parses without throwing", () => {
    const filePath = path.join(OPENPALM_DIR, "manual-reindex.yml");
    const result = parseTaskSource({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
    expect(result.version).toBe(4);
    expect(result.v4.target.kind).toBe("run");
    expect(result.v4.manualOnly).toBe(true);
    expect(result.v4.schedule).toHaveLength(0);
  });
});

// ── old crontab rows (akm < 0.9.2, #881; 0.9.0 – 0.9.17-alpha.6) ──────────
//
// The REAL shapes older installs wrote: each row is wrapped in akm's own
// `# akm:task <id> BEGIN`/`END` sentinels, but the invocation predates
// `--bundle` and the inline environment, or carries `--scheduler-context`.
// Before 0.10 an unparseable row was invisible to sync, which collided with
// the still-present artifact and blocked sync for every task (#881). Now the
// sentinels alone are enough: the rows are removed, never read.
describe("previous-release corpus — old crontab rows are replaced by the one entry, never parsed (#881)", () => {
  function memoryExec(initial = ""): CronExec & { current: () => string } {
    let store = initial;
    return {
      read: (): CronExecResult => ({ status: 0, stdout: store, stderr: "" }),
      write: (content: string): CronExecResult => {
        store = content;
        return { status: 0, stdout: "", stderr: "" };
      },
      current: () => store,
    };
  }

  test("pre-0.9.2 rows (no inline environment, no --bundle, `>>`) and 0.9.0-0.9.17 `--scheduler-context` rows go in one write", async () => {
    // Isolated from the real crontab throughout: `CRON_BACKEND` is given an
    // in-memory `exec`, never `spawnSync("crontab", …)`.
    let chain = () => {};
    chain = sandboxXdgConfigHome(chain).cleanup;
    chain = sandboxXdgStateHome(chain).cleanup;
    const stash = sandboxStashDir(chain);
    try {
      const tasksDir = path.join(stash.dir, "tasks");
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, "ping.yml"),
        'version: 4\nrun: echo ping\nname: ping\nschedule:\n  - cron: "*/15 * * * *"\n',
        "utf8",
      );
      const defaultBundle = path.basename(stash.dir).toLowerCase();
      setSchedulerRefEnabled(`${defaultBundle}//tasks/ping`, true);
      expect(loadConfig().scheduler?.enabled).toEqual([`${defaultBundle}//tasks/ping`]);

      const exec = memoryExec(
        [
          "# akm:task ping BEGIN",
          "*/15 * * * * /usr/local/bin/akm task run ping --scheduled >> /home/user/.local/state/akm/tasks/logs/ping.log 2>&1",
          "# akm:task ping END",
          "# akm:task pong BEGIN",
          "0 * * * * /usr/local/bin/akm task run pong --bundle stash --scheduler-context /home/user/.local/share/akm/tasks/context/pong.json > /home/user/.local/state/akm/tasks/logs/pong.log 2>&1",
          "# akm:task pong END",
          "",
        ].join("\n"),
      );
      const backend = CRON_BACKEND({ exec, logDir: "/home/user/.local/state/akm/tasks/logs", ensureDir: () => {} });

      const result = await akmTasksSync({
        backend,
        launcher: () => ({ argv: ["/usr/local/bin/akm"] }),
        env: { HOME: "/home/nobody", PATH: "/usr/bin" },
      });

      expect(result).toMatchObject({ entry: "installed", removedLegacy: ["ping", "pong"], keptLegacy: [] });
      expect((exec.current().match(/# akm:dispatch BEGIN/g) ?? []).length).toBe(1);
      expect(exec.current()).not.toContain("# akm:task");
      expect(exec.current()).not.toContain("--scheduler-context");
    } finally {
      stash.cleanup();
    }
  });
});

/** The parts of the converted 0.9 fixture that the end-to-end test reads. */
interface MigratedConfig {
  engines?: unknown;
  defaults?: unknown;
  workflow?: { judgeEngine?: unknown };
  connections: Record<string, Record<string, unknown> & { models?: Record<string, unknown> }>;
  harnesses: Record<string, { models?: Record<string, unknown> }>;
  improve: { strategy?: string; processes: Record<string, Record<string, unknown>> };
}

describe("previous-release corpus — a 0.9 `engines` config converts end to end through `akm migrate apply`", () => {
  let storage: IsolatedAkmStorage;
  let keyFile: string;

  /** A secret in the bundle's own store, which a `${secrets/openai}` key reads. */
  const STORED_SECRET = "sk-from-the-bundle-secret-store";
  const KEY_FILE_SECRET = "sk-from-the-key-file";
  const LITERAL = "sk-literal-from-0-9";

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetConfigCache();
    keyFile = path.join(storage.root, "lab.key");
    fs.writeFileSync(keyFile, `${KEY_FILE_SECRET}\n`);
    fs.mkdirSync(path.join(storage.stashDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, "secrets", "openai"), `${STORED_SECRET}\n`);
    const configDir = path.dirname(getConfigPath());
    // The 0.9 file, plus the working bundle the stored secret lives in.
    fs.writeFileSync(
      getConfigPath(),
      configNamingBundle(readFixture("config-v09-engines.json").replace("__KEY_FILE__", keyFile), storage.stashDir),
    );
    fs.writeFileSync(path.join(configDir, "models.json"), readFixture("models-v09.json"));
    // Assets that still say `engine:`.
    for (const [relative, text] of [
      ["commands/review.md", "---\nname: review\nakm:\n  engine: lab\n---\nReview it.\n"],
      [
        "workflows/nightly.md",
        "---\ntype: workflow\ndefaults:\n  engine: cloud\nsteps:\n  - id: one\n    unit: { engine: claude }\n---\n",
      ],
      ["tasks/daily.yml", "version: 4\nrun: echo hi\nengine: sdk\n"],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(storage.stashDir, relative)), { recursive: true });
      fs.writeFileSync(path.join(storage.stashDir, relative), text);
    }
  });
  afterEach(() => {
    _setWarnSinkForTests(undefined);
    resetConfigCache();
    storage.cleanup();
  });

  /** Every file under the config, cache and stash dirs, as bytes, to see that a dry run changes none. */
  function snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else out[file] = fs.readFileSync(file, "utf8");
      }
    };
    for (const directory of [path.dirname(getConfigPath()), storage.stashDir, path.join(storage.root, "cache")]) {
      if (fs.existsSync(directory)) visit(directory);
    }
    return out;
  }

  const read = (relative: string): string => fs.readFileSync(path.join(storage.stashDir, relative), "utf8");

  test("loads with no connection from it, one warning naming `akm migrate apply`, and the file is not touched", () => {
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const before = snapshot();

    const config = loadConfig();

    expect(config.connections ?? {}).toEqual({});
    expect(config.harnesses ?? {}).toEqual({});
    expect(warnings.filter((warning) => warning.includes("retired engines form"))).toHaveLength(2);
    expect(warnings.join("\n")).toContain("akm migrate apply");
    for (const secret of [KEY_FILE_SECRET, STORED_SECRET, LITERAL]) expect(warnings.join("\n")).not.toContain(secret);
    expect(snapshot()).toEqual(before);
  });

  test("--dry-run lists the whole plan and changes nothing", async () => {
    const before = snapshot();

    const plan = await runMigration({ apply: false });

    expect(plan.status).toBe("ready");
    expect(plan.configFile).toMatchObject({
      changed: true,
      applied: false,
      credentials: ["default", "cloud", "hosted"],
    });
    expect(plan.assetEngineKeys?.changed).toBe(3);
    expect(JSON.stringify(plan)).not.toMatch(new RegExp(`${KEY_FILE_SECRET}|${STORED_SECRET}|${LITERAL}`));
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(path.dirname(getConfigPath()), "credentials.json"))).toBe(false);
  });

  test("apply writes connections and harnesses, files the keys in credentials.json, folds and removes models.json, and rewrites the assets", async () => {
    const configDir = path.dirname(getConfigPath());
    const originalConfig = fs.readFileSync(getConfigPath(), "utf8");
    const originalModels = fs.readFileSync(path.join(configDir, "models.json"), "utf8");

    const plan = await runMigration({ apply: true });

    expect(plan.failedSteps).toBeUndefined();
    const configFile = plan.configFile;
    expect(configFile).toMatchObject({ changed: true, applied: true, credentials: ["default", "cloud", "hosted"] });

    // The file, converted: the default LLM engine is `default`, the runtime is gone, references follow.
    const written = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as MigratedConfig;
    expect(written.engines).toBeUndefined();
    expect(written.defaults).toBeUndefined();
    expect(written.workflow?.judgeEngine).toBeUndefined();
    expect(Object.keys(written.connections).sort()).toEqual(["cloud", "default", "env", "hosted"]);
    expect(written.harnesses).toEqual({ claude: expect.any(Object) });
    expect(written.improve.strategy).toBe("nightly");
    expect(written.improve.processes.reflect).toMatchObject({ connection: "cloud", model: "balanced" });
    expect(written.connections.default).toMatchObject({
      endpoint: "http://lab:8080/v1/chat/completions",
      temperature: 0.2,
      top_p: 0.9,
      contextLength: 32768,
      timeoutMs: 900000,
    });
    // The key a reference names stays a reference; the others are gone from the file.
    expect(written.connections.env?.apiKey).toBe("$ENV_ENGINE_KEY");
    for (const name of ["default", "cloud", "hosted"]) expect(written.connections[name]).not.toHaveProperty("apiKey");
    expect(JSON.stringify(written)).not.toMatch(
      new RegExp(`${KEY_FILE_SECRET}|${STORED_SECRET}|${LITERAL}|apiKeyFile`),
    );

    // credentials.json: each key for the connection (after the rename) and the endpoint it was stored for, 0600.
    const credentials = path.join(configDir, "credentials.json");
    expect(JSON.parse(fs.readFileSync(credentials, "utf8"))).toEqual({
      connections: {
        default: { key: KEY_FILE_SECRET, endpoint: "http://lab:8080/v1/chat/completions" },
        cloud: { key: STORED_SECRET, endpoint: "https://api.openai.com/v1/chat/completions" },
        hosted: { key: LITERAL, endpoint: "https://hosted.example.com/v1/chat/completions" },
      },
    });
    expect(fs.statSync(credentials).mode & 0o777).toBe(0o600);
    // The notes name places and entries, never values.
    const notes = (configFile?.notes ?? []).join("\n");
    expect(notes).toContain('engines.lab.apiKeyFile: its key moves to credentials.json for "default"');
    expect(notes).toContain('engines.cloud.apiKey: its key moves to credentials.json for "cloud"');
    expect(notes).toContain('engines.hosted.apiKey: its key moves to credentials.json for "hosted"');
    expect(notes).toContain("models.json coder.nowhere: names no configured connection or harness");
    expect(JSON.stringify(plan)).not.toMatch(new RegExp(`${KEY_FILE_SECRET}|${STORED_SECRET}|${LITERAL}`));

    // The config is backed up as it was.
    expect(fs.readFileSync(configFile?.backupPath as string, "utf8")).toBe(originalConfig);

    // models.json: folded in, then moved to the config backups.
    // `lab` has its own column for `fast`; the wildcard (a model that differs from the engine's own, with its
    // effort) and the flat shorthand reach every connection without one.
    expect(written.connections.default?.models).toEqual({
      fast: "qwen3-8b",
      balanced: "qwen3-30b-a3b",
      reasoning: { model: "qwen3-235b", reasoning_effort: "high" },
    });
    expect(written.connections.cloud?.models).toMatchObject({
      fast: "gpt-4o-mini",
      reasoning: { model: "qwen3-235b", reasoning_effort: "high" },
    });
    expect(written.harnesses.claude?.models).toMatchObject({ fast: "haiku" });
    expect(fs.existsSync(path.join(configDir, "models.json"))).toBe(false);
    expect(fs.readFileSync(configFile?.modelsFileBackupPath as string, "utf8")).toBe(originalModels);

    // The assets: `lab` is now `default`, `cloud` a connection, `claude` a harness, the runtime `sdk` is `lab`'s connection.
    expect(read("commands/review.md")).toBe("---\nname: review\nakm:\n  connection: default\n---\nReview it.\n");
    expect(read("workflows/nightly.md")).toContain("defaults:\n  connection: cloud");
    expect(read("workflows/nightly.md")).toContain("unit: { harness: claude }");
    expect(read("tasks/daily.yml")).toBe("version: 4\nrun: echo hi\nconnection: default\n");

    // Nothing is left to do, and the converted file reads with no warning.
    resetConfigCache();
    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    expect(loadConfig().connections?.default?.endpoint).toBe("http://lab:8080/v1/chat/completions");
    expect(warnings).toEqual([]);
    _setWarnSinkForTests(undefined);
    expect((await runMigration({ apply: false })).status).toBe("current");
  });
});
