// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeStateDbRoundTrip } from "../../../src/commands/health";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withEnv,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

/**
 * R-030 regression: `probeStateDbRoundTrip` (the `state-db-round-trip` health
 * check `akm health` runs on every invocation) used to append a permanent
 * `health_probe` event and never remove it — a read-only health check run on
 * a monitoring cron would grow state.db's `events` table without bound (the
 * only purge is `improve`'s retention pass, which a health-only user never
 * runs). The fix makes the probe self-cleaning: it still genuinely inserts
 * and reads back a row (proving the round trip works), but deletes that row
 * before returning, so repeated invocations leave the `events` table
 * untouched.
 */

function countEventsTable(): number {
  const db = openStateDatabase();
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

describe("probeStateDbRoundTrip (R-030)", () => {
  test("repeated invocations do not grow the events table", () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();
    try {
      const stateDbPath = getStateDbPath();
      for (let i = 0; i < 5; i++) {
        const result = probeStateDbRoundTrip(stateDbPath);
        expect(result.ok).toBe(true);
        expect(countEventsTable()).toBe(0);
      }
    } finally {
      storage.cleanup();
    }
  });

  test("does not disturb pre-existing events (only its own probe row is touched)", () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();
    try {
      const stateDbPath = getStateDbPath();
      const db = openStateDatabase(stateDbPath);
      try {
        db.prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, ?)").run(
          "reflect_invoked",
          new Date().toISOString(),
          "lessons/pre-existing",
          "{}",
        );
      } finally {
        db.close();
      }
      expect(countEventsTable()).toBe(1);

      const result = probeStateDbRoundTrip(stateDbPath);
      expect(result.ok).toBe(true);
      expect(countEventsTable()).toBe(1);

      const survivors = openStateDatabase(stateDbPath);
      try {
        const rows = survivors.prepare("SELECT event_type, ref FROM events").all() as Array<{
          event_type: string;
          ref: string | null;
        }>;
        expect(rows).toEqual([{ event_type: "reflect_invoked", ref: "lessons/pre-existing" }]);
      } finally {
        survivors.close();
      }
    } finally {
      storage.cleanup();
    }
  });
});

describe("health-no-probe-flag", () => {
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
   * `tests/health-checks.test.ts` — fails loudly.
   */

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
    test.each([false, true])("reachability remains on by default (read-only=%s)", async (readOnly) => {
      if (readOnly) openStateDatabase().close();
      const urls: string[] = [];
      const { code, stdout } = await withNoRealCrontab(() =>
        withMockedFetch(
          () => runCliCapture(["health", ...(readOnly ? ["--read-only"] : []), "--format", "json"]),
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

    test.each([false, true])("--no-probe skips all fetch calls (read-only=%s)", async (readOnly) => {
      if (readOnly) openStateDatabase().close();
      let fetchCalls = 0;
      const { code, stdout } = await withMockedFetch(
        () => runCliCapture(["health", ...(readOnly ? ["--read-only"] : []), "--no-probe", "--format", "json"]),
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
});
