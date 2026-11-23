// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #908 — an explicitly configured adapter (`adapter: "agent-skills"`) over a mixed-layout root skips everything outside
 * its own slice. Auto-detection cannot see that, so it is reported where adapters are compared: `akm bundle add` says it
 * once and `akm doctor` keeps saying it (`adapter-skipped-content`). `akm index` no longer prints it (§0.2 N18).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { akmIndex } from "../../../src/indexer/indexer";
import { runCliCapture } from "../../_helpers/cli";
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

function doctorSkip(stdout: string): { status: string; message: string } | undefined {
  const report = JSON.parse(stdout) as { advisories: Array<{ name: string; status: string; message: string }> };
  return report.advisories.find((check) => check.name === "adapter-skipped-content");
}

describe("an adapter that skips akm content (#908, N18)", () => {
  test("`akm index` does not warn", async () => {
    configureMixedBundle("agent-skills");

    const warnCalls: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level !== "warn") return;
      warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });

    await akmIndex({ stashDir: MIXED_ROOT, full: true });

    expect(warnCalls.some((m) => m.includes("adapter skipped"))).toBe(false);
  });

  test("`akm bundle add --adapter agent-skills` warns once with the count, the directories and the config key", async () => {
    const result = await runCliCapture(["bundle", "add", MIXED_ROOT, "--name", "mixed", "--adapter", "agent-skills"]);

    expect(result.code, result.stderr).toBe(0);
    const warning = result.stderr.split("\n").filter((line) => line.includes("adapter skipped"));
    expect(warning).toHaveLength(1);
    expect(warning[0]).toContain('bundle "mixed": agent-skills adapter skipped 5 files');
    for (const dir of ["knowledge/", "content/", "workflows/", "scripts/", "workspace/"])
      expect(warning[0]).toContain(dir);
    expect(warning[0]).toContain('bundles.mixed.adapter to "akm"');
  }, 60_000);

  test("`akm bundle add` with the `akm` adapter does not warn", async () => {
    const result = await runCliCapture(["bundle", "add", MIXED_ROOT, "--name", "mixed", "--adapter", "akm"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("adapter skipped");
  }, 60_000);

  test("`akm doctor` reports the explicit `agent-skills` adapter's skips as information, with the same text, and its exit code is unchanged", async () => {
    configureMixedBundle("agent-skills");

    const result = await runCliCapture(["doctor", "--no-probe", "--format", "json"]);

    const check = doctorSkip(result.stdout);
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain('bundle "mixed": agent-skills adapter skipped 5 files');
    // No other advisory is raised by this bundle, so the code is what `akm` (which skips nothing) gets.
    configureMixedBundle("akm");
    expect(result.code).toBe((await runCliCapture(["doctor", "--no-probe", "--format", "json"])).code);
  }, 60_000);

  test("`akm doctor` is silent when the bundle's adapter is `akm`", async () => {
    configureMixedBundle("akm");

    const result = await runCliCapture(["doctor", "--no-probe", "--format", "json"]);

    expect(doctorSkip(result.stdout)).toBeUndefined();
  }, 60_000);
});
