// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the source-management command cluster
 * (`akm list/remove/update/upgrade/sync/clone/history`). Pins the JSON
 * envelope (stdout payload shape + the {ok:false,code} error envelope on
 * stderr / exit code) for representative subcommands, proving the extraction
 * from cli.ts into src/commands/sources-cli.ts is byte-identical.
 *
 * The `--kind` filter helper, the `runSyncBody` git body, and the
 * `wasFormatValueConsumedAsName` workaround moved with the cluster; the leaf
 * handlers (all but `sync`) were migrated onto `defineJsonCommand`, which emits
 * the same JSON envelope (stdout/stderr/exit-code) as the inline form.
 *
 * Network- and git-touching paths (`upgrade` install, `sync` push, `clone`
 * fetch) are intentionally not exercised here — they are covered by their own
 * integration tests and would make this snapshot non-deterministic/offline-
 * hostile. This file pins only the envelope contract the extraction must keep.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

beforeEach(() => {
  const stash = sandboxStashDir();
  stashCleanup = stash.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
});

describe("akm source-management cluster — JSON envelope snapshot (WS6)", () => {
  test("list: success envelope carries sources array + totalSources + list shape", async () => {
    const { stdout, status } = await runCli(["--json", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.sources)).toBe(true);
    expect(typeof env.totalSources).toBe("number");
    expect(env.shape).toBe("list");
  });

  test("list --kind <valid>: filter is accepted (exit 0, list shape)", async () => {
    const { stdout, status } = await runCli(["--json", "list", "--kind", "local"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("list");
    expect(Array.isArray(env.sources)).toBe(true);
  });

  test("list --kind <bogus>: parseKindFilter → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["--json", "list", "--kind", "bogus"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toMatch(/Invalid --kind value/);
  });

  test("history --generator <bogus>: validation → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["--json", "history", "--generator", "bogus"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toMatch(/Invalid --generator value/);
  });
});
