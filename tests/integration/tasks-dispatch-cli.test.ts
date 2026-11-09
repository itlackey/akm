// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task sync` and `akm task dispatch` as separate processes against a stub
 * `crontab` (a script on PATH that reads and writes one file; the real crontab
 * is never reached):
 *   - a 0.9.32-style crontab ends with exactly one entry, in one write;
 *   - the `--scheduled` run an old row issues still works (an upgraded host runs
 *     old rows until its first sync);
 *   - the entry's own command, run the way cron runs it, starts a due task
 *     detached: the task keeps running, and finishes, after dispatch has exited.
 *
 * Linux only: the cron entry and the process-group behaviour are Linux/macOS
 * facts; the macOS and Windows equivalents are the native-scheduler gate
 * (tests/integration/native-scheduler.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { legacyCronBlock } from "../_helpers/legacy-scheduler";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
const LINUX = process.platform === "linux";

let sandbox: SandboxedDir;
let home: string;
let stash: string;
let fakeCrontab: string;
let env: NodeJS.ProcessEnv;

function akm(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const crontab = () => fs.readFileSync(fakeCrontab, "utf8");

/** The command of the entry's cron line, as cron hands it to `sh -c`. */
function entryCommand(text: string): string {
  const lines = text.split("\n");
  const begin = lines.indexOf("# akm:dispatch BEGIN");
  const line = lines.slice(begin + 1).find((candidate) => candidate.startsWith("* * * * * "));
  if (begin === -1 || !line) throw new Error(`no dispatch entry in:\n${text}`);
  return line.slice("* * * * * ".length);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

beforeAll(() => {
  sandbox = makeSandboxDir("akm-dispatch-cli");
  home = path.join(sandbox.dir, "home");
  stash = path.join(home, "akm");
  const fakeBin = path.join(sandbox.dir, "fake-bin");
  fakeCrontab = path.join(sandbox.dir, "crontab");
  for (const dir of [fakeBin, path.join(home, ".config", "akm"), path.join(stash, "tasks")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(fakeBin, "crontab"),
    [
      "#!/bin/sh",
      'if [ "${1:-}" = "-l" ]; then',
      '  if [ -f "$FAKE_CRONTAB" ]; then cat "$FAKE_CRONTAB"; exit 0; fi',
      '  echo "no crontab for sandbox" >&2',
      "  exit 1",
      "fi",
      'if [ "${1:-}" = "-" ]; then cp /dev/stdin "$FAKE_CRONTAB"; exit 0; fi',
      "exit 2",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // The default installation: HOME alone decides every location.
  env = {
    HOME: home,
    PATH: [fakeBin, "/usr/bin", "/bin"].join(path.delimiter),
    FAKE_CRONTAB: fakeCrontab,
    NO_COLOR: "1",
    CI: "1",
  };
  fs.writeFileSync(
    path.join(home, ".config", "akm", "config.json"),
    `${JSON.stringify({
      bundles: { stash: { path: stash, writable: true } },
      defaultBundle: "stash",
      semanticSearchMode: "off",
      scheduler: { enabled: ["stash//tasks/legacy-a", "stash//tasks/probe"] },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(stash, "tasks", "legacy-a.yml"),
    'version: 4\nrun: echo legacy-ran\nschedule: "0 3 * * *"\n',
  );
});

afterAll(() => sandbox?.cleanup());

describe.skipIf(!LINUX)("task sync and task dispatch, as processes", () => {
  const launcher = `${process.execPath} ${CLI}`;
  const userLines = ["MAILTO=ops@example.test", "17 4 * * * /usr/local/bin/backup-home"];

  test("a run with --scheduled from an old 0.9.32 row still works", () => {
    fs.writeFileSync(
      fakeCrontab,
      `${[
        ...userLines,
        "# akm:env BEGIN",
        `PATH=${env.PATH}`,
        "# akm:env END",
        legacyCronBlock(
          { id: "legacy-a", cron: "0 3 * * *", stashDir: stash },
          launcher,
          path.join(sandbox.dir, "logs"),
        ),
      ].join("\n")}\n`,
    );
    const row = crontab()
      .split("\n")
      .find((line) => line.includes("task run legacy-a")) as string;
    const command = row.replace(/^\S+ \S+ \S+ \S+ \S+ /, "").replace(/ > .*$/, "");

    // The row sets AKM_BUNDLE_DIR; this sandbox lives under /tmp, where akm would then move the config directory
    // into that stash (a real stash is under HOME). Naming the default config location keeps it where it is.
    const ran = spawnSync("/bin/sh", ["-c", command], {
      env: { HOME: home, PATH: env.PATH, XDG_CONFIG_HOME: path.join(home, ".config") },
      encoding: "utf8",
    });

    expect(ran.status, ran.stderr).toBe(0);
    const history = akm(["task", "history", "legacy-a", "--limit", "1"]);
    expect(history.status, history.stderr).toBe(0);
    expect((JSON.parse(history.stdout) as { rows: Array<{ status: string }> }).rows[0]?.status).toBe("completed");
  });

  test("task sync replaces every 0.9.32 row and the env block with exactly one entry, in one write, keeping the user's lines", () => {
    const before = crontab();
    expect(before).toContain("# akm:task legacy-a BEGIN");

    const synced = akm(["task", "sync"]);

    expect(synced.status, synced.stderr).toBe(0);
    expect(JSON.parse(synced.stdout)).toMatchObject({
      entry: "installed",
      removedLegacy: ["legacy-a"],
      keptLegacy: [],
    });
    const after = crontab();
    expect((after.match(/# akm:dispatch BEGIN/g) ?? []).length).toBe(1);
    expect(after).not.toContain("# akm:task");
    expect(after).not.toContain("# akm:env");
    expect(after.startsWith(`${userLines.join("\n")}\n`)).toBe(true);
    expect(entryCommand(after)).toContain("task dispatch");
  });

  test("a second sync changes nothing", () => {
    const before = crontab();

    const again = akm(["task", "sync"]);

    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ entry: "unchanged", removedLegacy: [] });
    expect(crontab()).toBe(before);
  });

  test("an installation that moves its state directory leaves the crontab alone and says to run dispatch itself", () => {
    const before = crontab();

    const result = akm(["task", "sync", "--rebind"], { AKM_STATE_DIR: path.join(sandbox.dir, "other-state") });

    expect(result.status, result.stderr).toBe(0);
    const synced = JSON.parse(result.stdout) as { entry: string; warnings: string[] };
    expect(synced.entry).toBe("unmanaged");
    expect(synced.warnings.join("\n")).toContain("akm task dispatch");
    expect(crontab()).toBe(before);
  });

  test("the entry, run the way cron runs it, starts a due task detached: it is still running when dispatch has exited, and finishes after", async () => {
    const marker = path.join(sandbox.dir, "probe-finished");
    fs.writeFileSync(
      path.join(stash, "tasks", "probe.yml"),
      `${["version: 4", `run: "sleep 4 && echo finished > ${marker}"`, 'schedule: "* * * * *"'].join("\n")}\n`,
    );

    const startedAt = Date.now();
    const dispatched = spawnSync("/bin/sh", ["-c", entryCommand(crontab())], {
      env: { HOME: home, PATH: env.PATH },
      encoding: "utf8",
      timeout: 60_000,
    });
    const dispatchMs = Date.now() - startedAt;

    expect(dispatched.status, dispatched.stderr).toBe(0);
    // The dispatch process has exited and its child has not finished: the child outlived it.
    expect(fs.existsSync(marker)).toBe(false);
    expect(dispatchMs).toBeLessThan(3500);

    expect(await waitFor(() => fs.existsSync(marker), 30_000)).toBe(true);
    expect(
      await waitFor(() => {
        const history = akm(["task", "history", "probe", "--limit", "1"]);
        const rows = (JSON.parse(history.stdout || '{"rows":[]}') as { rows: Array<{ status: string }> }).rows;
        return rows[0]?.status === "completed";
      }, 30_000),
    ).toBe(true);
  }, 120_000);

  test("a second dispatch while the first run is still going starts nothing", async () => {
    const marker = path.join(sandbox.dir, "probe-second");
    fs.writeFileSync(
      path.join(stash, "tasks", "probe.yml"),
      `${["version: 4", `run: "sleep 4 && echo finished > ${marker}"`, 'schedule: "* * * * *"'].join("\n")}\n`,
    );
    // Force the next minute to count: forget the minute the last dispatch recorded.
    const minuteFile = path.join(home, ".local", "state", "akm", "scheduler", "dispatch-minute");
    fs.rmSync(minuteFile, { force: true });
    const first = akm(["task", "dispatch"]);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).started).toEqual(["stash//tasks/probe"]);
    // Wait until the child has reserved its history row (it is active from then on).
    expect(
      await waitFor(() => {
        const history = akm(["task", "history", "probe", "--limit", "1"]);
        const rows = (
          JSON.parse(history.stdout || '{"rows":[]}') as { rows: Array<{ status: string; startedAt: string }> }
        ).rows;
        return rows[0]?.status === "active";
      }, 20_000),
    ).toBe(true);

    fs.rmSync(minuteFile, { force: true });
    const second = akm(["task", "dispatch"]);

    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ started: [], skipped: [{ ref: "stash//tasks/probe" }] });
    expect(await waitFor(() => fs.existsSync(marker), 30_000)).toBe(true);
  }, 120_000);
});
