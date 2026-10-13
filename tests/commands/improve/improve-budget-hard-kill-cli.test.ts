// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1168 §3.8: the budget watchdog's forced `process.exit(0)` skips every
 * finally and the CLI catch. The CLI hands `akmImprove` a hook that persists
 * the terminated run record, so a hard-killed run still leaves an improve_runs row.
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { akmImprove } from "../../../src/commands/improve/improve";
import { _setAkmImproveForTests } from "../../../src/commands/improve/improve-cli";
import { getStateDbPath } from "../../../src/core/state-db";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  _setAkmImproveForTests();
  for (const d of disposers.splice(0)) d.cleanup();
});

test("the hard-kill hook persists a terminated improve run with reason budget_exhausted", async () => {
  const stash = makeStashDir();
  disposers.push(stash);
  const dirs = ["home", "cfg", "cache", "data", "state"].map((n) => makeSandboxDir(`akm-hard-kill-${n}`));
  disposers.push(...dirs);
  const [home, cfg, cache, data, state] = dirs as [
    SandboxedDir,
    SandboxedDir,
    SandboxedDir,
    SandboxedDir,
    SandboxedDir,
  ];
  // Stands in for the watchdog: fire the hook the way the forced exit would, then stop.
  _setAkmImproveForTests((async (options: Parameters<typeof akmImprove>[0]) => {
    options?.onBudgetHardKill?.();
    throw new Error("stand-in for the forced exit");
  }) as unknown as typeof akmImprove);

  const row = await withEnv(
    {
      AKM_BUNDLE_DIR: stash.dir,
      HOME: home.dir,
      XDG_CONFIG_HOME: cfg.dir,
      XDG_CACHE_HOME: cache.dir,
      XDG_DATA_HOME: data.dir,
      XDG_STATE_HOME: state.dir,
    },
    async () => {
      writeSandboxConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: { ready: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "m" } },
        defaults: { llmEngine: "ready" },
      });
      await runCliCapture(["improve"]);
      const db = new Database(getStateDbPath(), { readonly: true });
      try {
        return db.prepare("SELECT ok, result_json FROM improve_runs").all() as Array<{
          ok: number;
          result_json: string;
        }>;
      } finally {
        db.close();
      }
    },
  );

  expect(row).toHaveLength(1);
  expect(row[0]?.ok).toBe(0);
  expect(JSON.parse(row[0]?.result_json ?? "{}")).toMatchObject({ terminated: { reason: "budget_exhausted" } });
});
