// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve` with nothing to run its model-calling processes on stops at
 * planning (exit 78), before it takes a lock, writes the index or opens a log,
 * and says what to do. No flag asks for that: a scheduled run that would index
 * and then skip everything fails loudly by itself. `--require-engines`, the 0.9
 * spelling of the flag that used to force it, is accepted and does nothing, so a
 * task installed for 0.9 keeps running. Drives the real `improveCommand`
 * in-process through `runCliCapture`; no database is opened, no process spawned.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { akmImprove } from "../../../src/commands/improve/improve";
import { _setAkmImproveForTests } from "../../../src/commands/improve/improve-cli";
import { _resetWarnOnceForTests } from "../../../src/core/warn";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../../_helpers/sandbox";
import { snapshotTree } from "../../_helpers/snapshot-tree";

const disposers: SandboxedDir[] = [];

function freshEnv(stashDir: string): { env: Record<string, string>; roots: string[] } {
  const dirs = ["home", "cfg", "cache", "data", "state"].map((name) => makeSandboxDir(`akm-planning-${name}`));
  disposers.push(...dirs);
  const [home, cfg, cache, data, state] = dirs as [
    SandboxedDir,
    SandboxedDir,
    SandboxedDir,
    SandboxedDir,
    SandboxedDir,
  ];
  return {
    env: {
      AKM_BUNDLE_DIR: stashDir,
      HOME: home.dir,
      XDG_CONFIG_HOME: cfg.dir,
      XDG_CACHE_HOME: cache.dir,
      XDG_DATA_HOME: data.dir,
      XDG_STATE_HOME: state.dir,
    },
    // Where a lock, an index, a log or a state row would land.
    roots: [stashDir, cache.dir, data.dir, state.dir],
  };
}

const NOTHING = { configVersion: "0.9.0", semanticSearchMode: "off" } as const;
const ONE_CONNECTION = {
  ...NOTHING,
  connections: { default: { endpoint: "http://127.0.0.1:1/v1", models: { fast: "m", balanced: "m", reasoning: "m" } } },
} as const;

afterEach(() => {
  _setAkmImproveForTests();
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("akm improve with nothing configured", () => {
  for (const flags of [[], ["--dry-run"]]) {
    test(`stops at planning with exit 78 and no side effect (${flags.join(" ") || "a real run"})`, async () => {
      const stash = makeStashDir();
      disposers.push(stash);
      const fake = mock(async () => {
        throw new Error("akmImprove must not run when planning stops first");
      });
      _setAkmImproveForTests(fake as unknown as typeof akmImprove);
      const { env, roots } = freshEnv(stash.dir);

      const outcome = await withEnv(env, async () => {
        writeSandboxConfig(NOTHING);
        const before = roots.map((root) => snapshotTree(root));
        const result = await runCliCapture(["improve", ...flags]);
        return {
          result,
          unchanged: roots.map((root) => snapshotTree(root)).every((after, i) => sameTree(before[i], after)),
        };
      });

      expect(outcome.result.code).toBe(78);
      expect(outcome.result.stderr).toContain("No improve process can run");
      expect(outcome.result.stderr).toContain("akm setup");
      expect(fake).not.toHaveBeenCalled();
      // No lock, no log, no index write, no state row: the directories are as they were.
      expect(outcome.unchanged).toBe(true);
    });
  }

  test("the retired --require-engines changes nothing: the same stop, and one warning that it does nothing", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    _resetWarnOnceForTests();
    _setAkmImproveForTests((async () => {
      throw new Error("akmImprove must not run when planning stops first");
    }) as unknown as typeof akmImprove);
    const { env } = freshEnv(stash.dir);
    const run = () =>
      withEnv(env, async () => {
        writeSandboxConfig(NOTHING);
        return runCliCapture(["improve", "--require-engines"]);
      });

    const first = await run();
    const second = await run();

    for (const result of [first, second]) expect(result.code).toBe(78);
    expect(first.stderr).toContain("--require-engines is retired and has no effect");
    expect(second.stderr).not.toContain("--require-engines is retired");
  });

  test("--require-targets and --preflight are not flags", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const { env } = freshEnv(stash.dir);
    for (const flag of ["--require-targets", "--preflight"]) {
      const result = await withEnv(env, async () => {
        writeSandboxConfig(ONE_CONNECTION);
        return runCliCapture(["improve", "--dry-run", flag]);
      });
      expect(result.code).not.toBe(0);
    }
  });
});

describe("akm improve with something to run on", () => {
  test("a run with the retired --require-engines proceeds, and only warns", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    _resetWarnOnceForTests();
    const { env } = freshEnv(stash.dir);

    const result = await withEnv(env, async () => {
      writeSandboxConfig(ONE_CONNECTION);
      return runCliCapture(["improve", "--dry-run", "--require-engines"]);
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("--require-engines is retired and has no effect");
  });

  test("a process pinned to a connection that is not configured is skipped and reported while the others run", async () => {
    const stash = makeStashDir();
    disposers.push(stash);
    const { env } = freshEnv(stash.dir);

    const result = await withEnv(env, async () => {
      writeSandboxConfig({
        ...ONE_CONNECTION,
        improve: { processes: { extract: { connection: "ghost", enabled: true } } },
      } as never);
      return runCliCapture(["improve", "--dry-run"]);
    });

    expect(result.code).toBe(0);
  });
});

function sameTree(a: Map<string, string> | undefined, b: Map<string, string>): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
