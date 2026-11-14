// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { type AkmConfig, saveConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { openStateDatabase } from "../../../../src/core/state-db";
import { akmIndex } from "../../../../src/indexer/indexer";
import { insertUsageEvent } from "../../../../src/indexer/usage/usage-events";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import {
  configHomeWithBundle,
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  makeStashDir as sandboxMakeStashDir,
  sandboxStashDir,
  sandboxXdgDataHome,
  withEnv,
  withIsolatedAkmStorage,
} from "../../../_helpers/sandbox";

// WHY THIS NEEDS A REAL SUBPROCESS (moved from tests/commands/improve-cli-flags.test.ts):
// `improve --dry-run` runs improve for real, which opens and writes the
// state.db (improve_runs). In-process, a SQLite write lock on state.db is
// already held within the test process (the unit suite keeps DB handles open
// across the run), so the in-process improve aborts with "state DB
// busy/locked after retries" — genuine process-level contention that a fresh
// subprocess does not have. Until the harness grows a way to release/clear
// all state.db handles before an improve-executing call, this test spawns a
// real `bun src/cli.ts` so it gets a clean, uncontended DB. Same documented
// harness gap as the improve-result-to-file subprocess tests.

const disposers: SandboxedDir[] = [];

function makeStashDir(): string {
  const stash = sandboxMakeStashDir();
  disposers.push(stash);
  return stash.dir;
}

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

/** Subprocess runner for improve-executing tests (see header comment).
 * Passes env to spawnSync rather than mutating process.env. */
function spawnImprove(
  args: string[],
  stashDir: string,
  extraConfig: Record<string, unknown> = {},
): { status: number; stdout: string; stderr: string } {
  const data = sandboxMakeStashDir();
  const config = makeSandboxDir("akm-improve-cli-config");
  disposers.push(data, config);
  const configPath = path.join(config.dir, "akm", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      semanticSearchMode: "off",
      connections: { test: { endpoint: "http://127.0.0.1:1/v1/chat/completions", models: { fast: "test" } } },
      ...extraConfig,
    }),
  );
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHomeWithBundle(config.dir, stashDir),
      XDG_DATA_HOME: data.dir,
    },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("improve CLI flags (0.8.0) — subprocess-only", () => {
  test("improve dry-run completes successfully (no cooldown flags needed)", () => {
    const stash = makeStashDir();
    const result = spawnImprove(
      [
        "improve",
        "--dry-run",
        // 0.8.0+ default mode writes JSON to a file; use the legacy escape
        // hatch so this assertion can read `ok` from stdout.
        "--json-to-stdout",
      ],
      stash,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  test("--harness moves every process of the run to that harness, and --connection with it is refused", () => {
    const stash = makeStashDir();
    const extra = { harnesses: { reviewer: { platform: "claude", bin: "/bin/true" } } };

    const moved = spawnImprove(["improve", "--dry-run", "--harness", "reviewer", "--json-to-stdout"], stash, extra);
    expect(moved.status).toBe(0);
    const { plan } = JSON.parse(moved.stdout) as {
      plan: { processes: Array<{ name: string; enabled: boolean; engine?: string }> };
    };
    const enabled = plan.processes.filter((process) => process.enabled && process.engine !== undefined);
    expect(enabled.length).toBeGreaterThan(0);
    expect(new Set(enabled.map((process) => process.engine))).toEqual(new Set(["reviewer"]));

    const both = spawnImprove(
      ["improve", "--dry-run", "--harness", "reviewer", "--connection", "test", "--json-to-stdout"],
      stash,
      extra,
    );
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("--connection and --harness are mutually exclusive");
  });
});

describe("coverage-gaps", () => {
  /**
   * `akm improve` reports zero-result searches as coverage gaps. The summary
   * search event lives in state.db's `usage_events` (query column, resultCount
   * in metadata). Opens a real state.db and index.db (integration per ORG-03).
   */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => {
    storage.cleanup();
  });

  test("a zero-result search in state.db is reported as a coverage gap", async () => {
    const stash = storage.stashDir;
    const config = withTestImproveLlm({
      semanticSearchMode: "off",
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
    } as AkmConfig);
    saveConfig(config);
    await akmIndex({ stashDir: stash, full: true });

    const db = openStateDatabase();
    try {
      // The summary row `logSearchEvent` writes: no entry_ref, resultCount in metadata.
      insertUsageEvent(db, {
        event_type: "search",
        query: "kubernetes ingress",
        metadata: JSON.stringify({ resultCount: 0 }),
      });
      insertUsageEvent(db, { event_type: "search", query: "found it", metadata: JSON.stringify({ resultCount: 1 }) });
    } finally {
      db.close();
    }

    const result = await akmImprove({
      scope: "skill",
      stashDir: stash,
      config,
      reindexFn: async () => undefined,
    });

    expect(result.coverageGaps).toEqual(["kubernetes ingress"]);
  });
});

test("improve failure events redact materialized engine credentials", async () => {
  const sentinel = "IMPROVE-EVENT-SECRET";
  const data = sandboxXdgDataHome();
  const stash = sandboxStashDir(data.cleanup);
  try {
    await expect(
      withEnv({ IMPROVE_TEST_API_KEY: sentinel }, () =>
        akmImprove({
          stashDir: stash.dir,
          config: {
            semanticSearchMode: "off",
            connections: {
              default: {
                endpoint: "https://example.test/v1/chat/completions",
                models: { fast: "test" },
                apiKey: "$IMPROVE_TEST_API_KEY",
              },
            },
            improve: {
              strategy: "redaction-test",
              strategies: {
                "redaction-test": {
                  processes: {
                    reflect: { enabled: false },
                    distill: { enabled: false },
                    consolidate: { enabled: false },
                    memoryInference: { enabled: false },
                    extract: { enabled: false },
                    triage: { enabled: false },
                  },
                },
              },
            },
          },
          reindexFn: async () => undefined,
          collectEligibleRefsFn: (async () => ({
            plannedRefs: [],
            memorySummary: { eligible: 0, derived: 0 },
            strategyFilteredRefs: [],
          })) as never,
          runImprovePreparationStageFn: (async () => {
            throw new Error(`provider echoed ${sentinel}`);
          }) as never,
        }),
      ),
    ).rejects.toThrow("provider echoed");

    const failed = readEvents({ type: "improve_failed" }).events;
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain(sentinel);
    expect(JSON.stringify(failed)).toContain("[REDACTED]");
  } finally {
    stash.cleanup();
  }
});
