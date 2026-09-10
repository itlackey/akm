// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve --require-engines` (#957): abort before any indexing, lock, or
 * log side effect when the active strategy's plan already knows a process is
 * unavailable, instead of the default degrade-and-report-in-skippedProcesses
 * behavior. Drives the real `improveCommand` in-process via `runCliCapture`
 * (see tests/_helpers/cli.ts) — no real database is opened and no process is
 * spawned, so this belongs under `tests/`, not `tests/integration/`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { akmImprove } from "../../../src/commands/improve/improve";
import { _setAkmImproveForTests } from "../../../src/commands/improve/improve-cli";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function freshEnv(stashDir: string): Record<string, string> {
  return {
    AKM_BUNDLE_DIR: stashDir,
    HOME: makeSandboxDir("akm-require-engines-home").dir,
    XDG_CONFIG_HOME: makeSandboxDir("akm-require-engines-cfg").dir,
    XDG_CACHE_HOME: makeSandboxDir("akm-require-engines-cache").dir,
    XDG_DATA_HOME: makeSandboxDir("akm-require-engines-data").dir,
    XDG_STATE_HOME: makeSandboxDir("akm-require-engines-state").dir,
  };
}

// A config where the default strategy's "reflect" process is pinned to an
// engine whose credential is not (and, deliberately, will never be) in the
// process environment, while `defaults.llmEngine` ("ready") remains fully
// available — so `resolveImprovePlan` disables just "reflect" instead of
// hitting the separate ALL-disabled ConfigError.
function writePartiallyUnavailableConfig(): void {
  writeSandboxConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    engines: {
      ready: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "ready-model" },
      private: {
        kind: "llm",
        endpoint: "https://example.test/v1/chat/completions",
        model: "private-model",
        apiKey: "$MISSING_957_CLI_TOKEN",
      },
    },
    defaults: { llmEngine: "ready" },
    improve: {
      strategies: {
        default: { processes: { reflect: { engine: "private" } } },
      },
    },
  });
}

afterEach(() => {
  _setAkmImproveForTests();
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("akm improve --require-engines", () => {
  test("aborts with exit 78 before akmImprove runs, naming the unresolved reference per process", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const fakeAkmImprove = mock(async () => {
      throw new Error("akmImprove must not run when --require-engines aborts first");
    });
    _setAkmImproveForTests(fakeAkmImprove as unknown as typeof akmImprove);

    const result = await withEnv(freshEnv(stash.dir), async () => {
      writePartiallyUnavailableConfig();
      return runCliCapture(["improve", "--dry-run", "--require-engines"]);
    });

    expect(result.code).toBe(78);
    expect(result.stderr).toContain("--require-engines");
    expect(result.stderr).toContain("reflect");
    expect(result.stderr).toContain("private");
    expect(result.stderr).toContain("$MISSING_957_CLI_TOKEN");
    expect(result.stderr).toContain("is not set in this environment");
    expect(fakeAkmImprove).not.toHaveBeenCalled();
  });

  test("without the flag, the run proceeds and the result carries skippedProcesses", async () => {
    const stash = makeStashDir();
    disposers.push(stash);

    const result = await withEnv(freshEnv(stash.dir), async () => {
      writePartiallyUnavailableConfig();
      return runCliCapture(["improve", "--dry-run"]);
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      skippedProcesses?: Array<{ process: string; configKey: string; reason: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.skippedProcesses).toEqual([
      expect.objectContaining({
        process: "reflect",
        configKey: "improve.strategies.default.processes.reflect.engine",
        reason: expect.stringContaining('engine "private"'),
      }),
    ]);
  });
});
