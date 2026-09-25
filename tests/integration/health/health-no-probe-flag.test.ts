// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #914: `akm health --no-probe` must actually route through to skip the
 * reachability probes. This pins a real citty gotcha found while wiring the
 * flag: citty's argument parser treats ANY `--no-X` argument as negating a
 * flag named `X` (stripping the `no-` prefix unconditionally — see
 * `parseArgs` in `citty`'s `dist/index.mjs`), so declaring an arg literally
 * named `"no-probe"` would silently never populate `args["no-probe"]` and
 * `--no-probe` would do nothing. The fix declares a positive `probe` arg
 * (default `true`); `--no-probe` is citty's automatic negation of it.
 *
 * This test exercises the CLI end-to-end (not just `runDefaultLlmEngineProbe`
 * directly) specifically so a regression in the flag NAME/wiring — not just
 * the underlying probe logic already covered by
 * `tests/health-engine-probe.test.ts` — fails loudly.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as akmInstallsModule from "../../../src/core/akm-installs";
import { getStateDir } from "../../../src/core/paths";
import { pkgVersion } from "../../../src/version";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withEnv,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

/**
 * `--probe` also gates two other advisories that shell out to real host
 * state regardless of the HOME/XDG sandboxing `withIsolatedAkmStorage`
 * provides:
 *
 * - `scheduler-binary` (`src/commands/health/scheduler-binary.ts`) runs the
 *   REAL platform scheduler (`crontab -l` on Linux) — crontab is keyed to
 *   the OS user, not `$HOME`. On a host that actually has akm entries
 *   scheduled (e.g. a dogfooding dev machine), that leaks a real "scheduled
 *   tasks are bound to an old akm version" warning into this test.
 * - `akm-installs` (upgrade-D r2-3, `src/commands/health/akm-installs.ts`)
 *   enumerates every `akm` on the REAL `PATH` and known install roots
 *   (`enumerateAkmInstalls`, `src/core/akm-installs.ts`), including the
 *   hardcoded `/usr/local/bin` fixed root — `collectAkmInstallsAdvisory`
 *   never forwards a `fixedRoots` override, so there is no way to disable
 *   that root from here the way
 *   `tests/integration/core/akm-installs.test.ts` does directly. This
 *   currently happens to pass on a dev host running this exact worktree's
 *   version, but warns (flipping the exit code) on any other host, or after
 *   any version bump.
 *
 * Either leaking in flips the overall exit code to 4, unrelated to the
 * reachability probe under test here. `PATH` is replaced (never prepended
 * to the real one) with a single controlled directory holding a fake
 * `crontab` that reports an empty schedule and a stub `akm` that reports
 * the running version, `NVM_DIR` is unset so no real nvm install directory
 * leaks in either, `BUN_INSTALL` is unset too (upgrade-D3 r3-4:
 * `enumerateAkmInstalls` now also scans `${BUN_INSTALL:-~/.bun}/lib/node_modules`
 * unconditionally, and a developer's shell commonly exports `BUN_INSTALL`
 * regardless of the HOME sandbox), and `enumerateAkmInstalls` itself is
 * wrapped (real `spawnSync`/`fs` still run — only `fixedRoots` is forced to
 * `[]`) since that option cannot be reached through the CLI/health plumbing.
 */
async function withSandboxedProbeEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-health-probe-sandbox-"));
  const fakeCrontab = path.join(dir, "crontab");
  fs.writeFileSync(fakeCrontab, "#!/usr/bin/env sh\nexit 1\n");
  fs.chmodSync(fakeCrontab, 0o755);
  const stubAkm = path.join(dir, "akm");
  fs.writeFileSync(stubAkm, `#!/bin/sh\necho ${pkgVersion}\n`);
  fs.chmodSync(stubAkm, 0o755);

  const realEnumerate = akmInstallsModule.enumerateAkmInstalls;
  const spy = spyOn(akmInstallsModule, "enumerateAkmInstalls").mockImplementation((env, options) =>
    realEnumerate(env, { ...options, fixedRoots: [] }),
  );
  try {
    return await withEnv({ PATH: dir, NVM_DIR: undefined, BUN_INSTALL: undefined }, fn);
  } finally {
    spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    engines: {
      lab: { kind: "llm", endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "test-model" },
    },
    defaults: { llmEngine: "lab" },
  });
  // upgrade-D/D2: `runCliCapture` deliberately never runs the real CLI's
  // startup reconciliation (see its own module doc), so the sandboxed host
  // otherwise looks like it has never reconciled — the `version-reconcile`
  // advisory would warn and flip the overall exit code to 4, unrelated to
  // the reachability probe under test here. Seed a matching stamp, same
  // reasoning as `withNoRealCrontab` below for `scheduler-binary`.
  const stateDir = getStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "version-reconcile.json"), JSON.stringify({ version: pkgVersion }));
});

afterEach(() => {
  storage.cleanup();
});

function chatCompletionResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("akm health --no-probe (#914)", () => {
  test("without --no-probe, the reachability probe actually fires (a real fetch)", async () => {
    let fetchCalls = 0;
    const { code, stdout } = await withSandboxedProbeEnvironment(() =>
      withMockedFetch(
        () => runCliCapture(["health", "--format", "json"]),
        () => {
          fetchCalls += 1;
          return chatCompletionResponse();
        },
      ),
    );
    expect(fetchCalls).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout) as {
      hardChecks: Array<{ name: string; status: string; message: string }>;
      advisories: Array<{
        name: string;
        status: string;
        evidence?: {
          installs?: Array<{
            path: string;
            binDir: string;
            manager: string;
            version?: string;
            isRunning: boolean;
            linked: boolean;
          }>;
        };
      }>;
    };
    const check = parsed.hardChecks.find((c) => c.name === "default-llm-engine");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("reachable");

    // upgrade-D r2-3: pins that the akm-installs advisory saw ONLY the
    // sandbox's stub akm — not this host's real installs — so the exit
    // code above cannot flip to 4 because of whatever happens to be on the
    // real host's PATH/known install roots.
    const installsCheck = parsed.advisories.find((c) => c.name === "akm-installs");
    expect(installsCheck?.status).toBe("pass");
    expect(installsCheck?.evidence?.installs).toEqual([
      {
        path: expect.stringContaining("akm-health-probe-sandbox-"),
        binDir: expect.stringContaining("akm-health-probe-sandbox-"),
        manager: "standalone",
        version: pkgVersion,
        isRunning: false,
        linked: true,
      },
    ]);

    expect(code).toBe(0);
  });

  test("--no-probe skips the reachability probe entirely (no fetch call)", async () => {
    let fetchCalls = 0;
    const { code, stdout } = await withMockedFetch(
      () => runCliCapture(["health", "--no-probe", "--format", "json"]),
      () => {
        fetchCalls += 1;
        return chatCompletionResponse();
      },
    );
    expect(fetchCalls).toBe(0);
    const parsed = JSON.parse(stdout) as { hardChecks: Array<{ name: string; status: string; message: string }> };
    const check = parsed.hardChecks.find((c) => c.name === "default-llm-engine");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("Reachability was not probed");
    expect(code).toBe(0);
  });
});
