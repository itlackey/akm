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
 * This test exercises the CLI end-to-end (not just `runConnectionsAndHarnessesCheck`
 * directly) specifically so a regression in the flag NAME/wiring — not just
 * the underlying probe logic already covered by
 * `tests/health-connections-and-harnesses-check.test.ts` — fails loudly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    connections: { lab: { endpoint: "http://127.0.0.1:9/v1", models: { fast: "test-model" } } },
  });
});

afterEach(() => {
  storage.cleanup();
});

function modelsResponse(): Response {
  return Response.json({ data: [{ id: "test-model" }] });
}

type ConnectionsAndHarnessesCheck = {
  name: string;
  status: string;
  message: string;
  evidence: { rows: Array<Record<string, unknown>> };
};
const targetsOf = (stdout: string): ConnectionsAndHarnessesCheck =>
  (JSON.parse(stdout) as { hardChecks: ConnectionsAndHarnessesCheck[] }).hardChecks.find(
    (c) => c.name === "connections-and-harnesses",
  ) as ConnectionsAndHarnessesCheck;

describe("akm health --no-probe (#914)", () => {
  test("without --no-probe, the reachability probe actually fires (a real fetch)", async () => {
    const urls: string[] = [];
    const { code, stdout } = await withNoRealCrontab(() =>
      withMockedFetch(
        () => runCliCapture(["health", "--format", "json"]),
        (url) => {
          urls.push(url);
          return modelsResponse();
        },
      ),
    );
    expect(urls).toContain("http://127.0.0.1:9/v1/models");
    const check = targetsOf(stdout);
    expect(check.status).toBe("pass");
    expect(check.evidence.rows[0]).toMatchObject({ type: "connection", name: "lab", reachable: true });
    expect(check.message).not.toContain("not probed");
    expect(code).toBe(0);
  });

  test("--no-probe skips the reachability probe entirely (no fetch call)", async () => {
    let fetchCalls = 0;
    const { code, stdout } = await withMockedFetch(
      () => runCliCapture(["health", "--no-probe", "--format", "json"]),
      () => {
        fetchCalls += 1;
        return modelsResponse();
      },
    );
    expect(fetchCalls).toBe(0);
    const check = targetsOf(stdout);
    expect(check.status).toBe("pass");
    expect(check.message).toContain("Reachability was not probed");
    expect(check.evidence.rows[0]).not.toHaveProperty("reachable");
    expect(code).toBe(0);
  });
});
