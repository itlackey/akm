// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve --plan` (#947): a zero-logic discoverability alias for
 * `--dry-run` — it must set the exact same internal `dryRun` option and never
 * fork the computation. Drives the real `improveCommand` in-process via
 * `runCliCapture` (see tests/_helpers/cli.ts) with a fake `akmImprove` that
 * only records the options it was called with — no real database is opened
 * and no process is spawned, so this belongs under `tests/`, not
 * `tests/integration/`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { akmImprove } from "../../../src/commands/improve/improve";
import { _setAkmImproveForTests } from "../../../src/commands/improve/improve-cli";
import type { AkmImproveOptions } from "../../../src/commands/improve/improve-run-types";
import type { AkmImproveResult } from "../../../src/core/improve-types";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function freshEnv(stashDir: string): Record<string, string> {
  return {
    AKM_BUNDLE_DIR: stashDir,
    HOME: makeSandboxDir("akm-plan-flag-home").dir,
    XDG_CONFIG_HOME: makeSandboxDir("akm-plan-flag-cfg").dir,
    XDG_CACHE_HOME: makeSandboxDir("akm-plan-flag-cache").dir,
    XDG_DATA_HOME: makeSandboxDir("akm-plan-flag-data").dir,
    XDG_STATE_HOME: makeSandboxDir("akm-plan-flag-state").dir,
  };
}

function writeResolvableConfig(): void {
  writeSandboxConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    engines: { default: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "base" } },
    defaults: { llmEngine: "default" },
  });
}

const fakeResult: AkmImproveResult = {
  schemaVersion: 2,
  ok: true,
  strategy: "default",
  scope: { mode: "all" },
  dryRun: true,
  memorySummary: { eligible: 0, derived: 0 },
  plannedRefs: [],
};

/** Records the `dryRun` value each call received, in call order. */
function makeRecordingAkmImprove(seen: boolean[]): typeof akmImprove {
  return mock((options: AkmImproveOptions) => {
    seen.push(Boolean(options.dryRun));
    return Promise.resolve(fakeResult);
  }) as unknown as typeof akmImprove;
}

afterEach(() => {
  _setAkmImproveForTests();
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("akm improve --plan", () => {
  test("sets the same dryRun option as --dry-run, without forking the computation", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const seen: boolean[] = [];
    _setAkmImproveForTests(makeRecordingAkmImprove(seen));

    await withEnv(freshEnv(stash.dir), async () => {
      writeResolvableConfig();
      const result = await runCliCapture(["improve", "--plan"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true });
    });

    expect(seen).toEqual([true]);
  });

  test("--plan and --dry-run pass the identical dryRun value to akmImprove", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const seen: boolean[] = [];
    _setAkmImproveForTests(makeRecordingAkmImprove(seen));

    await withEnv(freshEnv(stash.dir), async () => {
      writeResolvableConfig();
      await runCliCapture(["improve", "--plan"]);
      await runCliCapture(["improve", "--dry-run"]);
    });

    expect(seen).toEqual([true, true]);
  });
});
