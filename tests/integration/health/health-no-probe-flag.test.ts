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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
 * `--probe` also gates the unrelated `scheduler-binary` advisory
 * (`src/commands/health/scheduler-binary.ts`), which shells out to the
 * REAL platform scheduler (`crontab -l` on Linux) regardless of the
 * HOME/XDG sandboxing `withIsolatedAkmStorage` provides — crontab is keyed
 * to the OS user, not `$HOME`. On a host that actually has akm entries
 * scheduled (e.g. a dogfooding dev machine), that leaks a real "scheduled
 * tasks are bound to an old akm version" warning into this test and flips
 * the overall exit code to 4, unrelated to the reachability probe under
 * test here. Prepend a fake `crontab` that reports an empty schedule so the
 * advisory resolves to its "no scheduled task" `unknown` status, same as a
 * clean CI runner, instead of depending on whatever happens to be in the
 * real user crontab.
 */
async function withNoRealCrontab<T>(fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-no-crontab-"));
  const fakeCrontab = path.join(dir, "crontab");
  fs.writeFileSync(fakeCrontab, "#!/usr/bin/env sh\nexit 1\n");
  fs.chmodSync(fakeCrontab, 0o755);
  try {
    return await withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` }, fn);
  } finally {
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
    const { code, stdout } = await withNoRealCrontab(() =>
      withMockedFetch(
        () => runCliCapture(["health", "--format", "json"]),
        () => {
          fetchCalls += 1;
          return chatCompletionResponse();
        },
      ),
    );
    expect(fetchCalls).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout) as { hardChecks: Array<{ name: string; status: string; message: string }> };
    const check = parsed.hardChecks.find((c) => c.name === "default-llm-engine");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("reachable");
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
