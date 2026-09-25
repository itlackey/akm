// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RUNTIME-03/ORG-03: this suite installs the PREVIOUS published `akm-cli`
 * release and the CANDIDATE build as real global npm packages (real `npm
 * pack` / `npm install --global` into throwaway prefixes), uses the previous
 * release to build a realistic home (five bundle kinds, scheduled tasks, a
 * synced fake crontab), then drives the candidate against that home and the
 * previous release back against the candidate-written home. It shells out to
 * real `npm`/`git` subprocesses, spawns real installed binaries, and serves
 * local HTTP fixtures — it belongs in the integration target, not the unit
 * target, which must stay hermetic and host-independent.
 *
 * Gated behind `AKM_UPGRADE_REHEARSAL=1` (unset: logs one line and skips).
 * See docs/architecture/testing/testing-workflow.md's "Upgrade Regression
 * Coverage" section for how to run this locally and its env overrides.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCandidateTarball } from "./candidate";
import { requireUpgradeRehearsalCapabilities } from "./gate";
import { buildHome, type UpgradeHome } from "./home";
import { installAkmTarball, runLauncher } from "./install";
import { fetchPreviousReleaseTarball, resolvePreviousReleaseVersion } from "./previous-release";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const REQUESTED = process.env.AKM_UPGRADE_REHEARSAL === "1";

if (!REQUESTED) {
  console.log("AKM_UPGRADE_REHEARSAL is not set to 1 — skipping the upgrade rehearsal gate.");
}

requireUpgradeRehearsalCapabilities({
  requested: REQUESTED,
  npmAvailable: Bun.which("npm") !== null,
  candidateTarballProvided: Boolean(process.env.AKM_CANDIDATE_TARBALL?.trim()),
  distCliExists: fs.existsSync(path.join(REPO_ROOT, "dist", "cli.js")),
});

function candidatePackageVersion(): string {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  const version = (JSON.parse(raw) as { version?: string }).version;
  if (!version) throw new Error("package.json has no version");
  return version;
}

/** Extract a scheduled task's generated `akm task run …` command tail from the fake crontab. */
function extractCronCommandContaining(crontab: string, needle: string): string {
  const lines = crontab.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/^# akm:task .+ BEGIN$/.test(lines[index] ?? "")) continue;
    const body = lines[index + 1] ?? "";
    if (!body.includes(needle)) continue;
    const match = body.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (match) return match[1] as string;
  }
  throw new Error(`No crontab entry's command references ${JSON.stringify(needle)}:\n${crontab}`);
}

describe.skipIf(!REQUESTED)("upgrade rehearsal: candidate against a previous-release-built home", () => {
  let workRoot: string;
  let previousVersion: string;
  let previousLauncher: string;
  let previousPrefix: string;
  let candidateLauncher: string;
  let candidatePrefix: string;
  let candidateVersion: string;
  let home: UpgradeHome;

  beforeAll(async () => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-upgrade-rehearsal-"));
    const cacheRoot = path.join(os.tmpdir(), "akm-upgrade-rehearsal");
    fs.mkdirSync(cacheRoot, { recursive: true });

    candidateVersion = candidatePackageVersion();
    previousVersion = await resolvePreviousReleaseVersion(candidateVersion);

    const [previousTarball, candidateTarball] = await Promise.all([
      fetchPreviousReleaseTarball(previousVersion, cacheRoot),
      resolveCandidateTarball(REPO_ROOT, workRoot),
    ]);

    const prefixRoot = path.join(workRoot, "prefixes");
    fs.mkdirSync(prefixRoot, { recursive: true });
    const [previousInstall, candidateInstall] = await Promise.all([
      installAkmTarball(previousTarball, prefixRoot, "previous", previousVersion),
      installAkmTarball(candidateTarball, prefixRoot, "candidate", candidateVersion),
    ]);
    previousLauncher = previousInstall.launcher;
    previousPrefix = previousInstall.prefix;
    candidateLauncher = candidateInstall.launcher;
    candidatePrefix = candidateInstall.prefix;

    home = await buildHome(previousLauncher, path.join(workRoot, "home"));
  }, 900_000);

  afterAll(() => {
    if (workRoot) fs.rmSync(workRoot, { recursive: true, force: true });
  });

  test("1. candidate --version prints the candidate version", async () => {
    const result = await runLauncher(candidateLauncher, ["--version"], home.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(candidateVersion);
  });

  test("2. candidate migrate status is current or ready with no blockers", async () => {
    const result = await runLauncher(candidateLauncher, ["migrate", "status"], home.env);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout) as { status?: string; blockers?: string[] };
    expect(["current", "ready"]).toContain(plan.status ?? "");
    expect(plan.blockers ?? []).toEqual([]);
  });

  test("3. candidate migrate apply succeeds and status then reports current", async () => {
    const apply = await runLauncher(candidateLauncher, ["migrate", "apply"], home.env);
    expect(apply.status, apply.stderr).toBe(0);

    const status = await runLauncher(candidateLauncher, ["migrate", "status"], home.env);
    expect(status.status, status.stderr).toBe(0);
    const plan = JSON.parse(status.stdout) as { status?: string };
    expect(plan.status).toBe("current");
  });

  test("4. core read surfaces succeed: config get, bundle list, info, search, show, task list", async () => {
    const configGet = await runLauncher(candidateLauncher, ["config", "get", "defaultBundle"], home.env);
    expect(configGet.status, configGet.stderr).toBe(0);

    const bundleList = await runLauncher(candidateLauncher, ["bundle", "list"], home.env);
    expect(bundleList.status, bundleList.stderr).toBe(0);
    const listed = JSON.parse(bundleList.stdout) as { sources?: { name?: string }[] };
    const names = (listed.sources ?? []).map((source) => source.name);
    for (const expected of Object.values(home.bundles)) {
      expect(names).toContain(expected);
    }
    expect(listed.sources?.length ?? 0).toBe(5);

    const info = await runLauncher(candidateLauncher, ["info"], home.env);
    expect(info.status, info.stderr).toBe(0);

    const search = await runLauncher(candidateLauncher, ["search", home.searchTerm], home.env);
    expect(search.status, search.stderr).toBe(0);
    const searched = JSON.parse(search.stdout) as { hits?: { ref?: string }[] };
    expect(searched.hits?.length ?? 0).toBeGreaterThan(0);
    const ref = searched.hits?.[0]?.ref;
    expect(ref).toBeTruthy();

    const show = await runLauncher(candidateLauncher, ["show", ref as string], home.env);
    expect(show.status, show.stderr).toBe(0);

    const taskList = await runLauncher(candidateLauncher, ["task", "list"], home.env);
    expect(taskList.status, taskList.stderr).toBe(0);
  });

  test("5. task sync --dry-run is clean: no removals, no failures, a/b preserved", async () => {
    const result = await runLauncher(candidateLauncher, ["task", "sync", "--dry-run"], home.env);
    expect(result.status, result.stderr).toBe(0);
    const preview = JSON.parse(result.stdout) as { removed?: string[]; failures?: unknown[] };
    expect(preview.failures ?? []).toEqual([]);
    const removed = preview.removed ?? [];
    expect(removed.some((entry) => entry.includes(home.taskIds.a))).toBe(false);
    expect(removed.some((entry) => entry.includes(home.taskIds.b))).toBe(false);
  });

  test("6. task sync rebinds a/b to the candidate launcher; c stays absent", async () => {
    // `--rebind`: plain `task sync` treats an installed binding whose
    // schedule/inputs already match the desired state as satisfied and
    // leaves its recorded invocation (including the launcher path) alone —
    // it does not implicitly repoint every binding at whichever binary is
    // running sync today. `--rebind` is the documented flag for "replace
    // installed bindings with the current invocation" (tasks-cli.ts), which
    // is what an upgrade that moved the launcher path needs.
    const result = await runLauncher(candidateLauncher, ["task", "sync", "--rebind"], home.env);
    expect(result.status, result.stderr).toBe(0);

    const crontab = fs.readFileSync(home.fakeCrontab, "utf8");
    const commandA = extractCronCommandContaining(crontab, home.taskIds.a);
    const commandB = extractCronCommandContaining(crontab, home.taskIds.b);
    // The generated command embeds the RESOLVED launcher target
    // (`<prefix>/lib/node_modules/akm-cli/dist/akm`), not the npm-generated
    // `<prefix>/bin/akm` symlink `candidateLauncher` itself — compare
    // against the candidate's install prefix instead of the exact launcher
    // string, and confirm the previous install's prefix is gone.
    expect(commandA).toContain(candidatePrefix);
    expect(commandB).toContain(candidatePrefix);
    expect(commandA).not.toContain(previousPrefix);
    expect(commandB).not.toContain(previousPrefix);
    expect(crontab.includes(home.taskIds.c)).toBe(false);
  });

  test("7. the generated cron command for scheduled-a executes and writes a task log", async () => {
    const crontab = fs.readFileSync(home.fakeCrontab, "utf8");
    const command = extractCronCommandContaining(crontab, home.taskIds.a);
    const executed = await runLauncher("/bin/sh", ["-c", command], home.env);
    expect(executed.status, executed.stderr).toBe(0);

    const history = await runLauncher(
      candidateLauncher,
      ["task", "history", `stash//tasks/${home.taskIds.a}`, "--limit", "1"],
      home.env,
    );
    expect(history.status, history.stderr).toBe(0);
    const rows = (JSON.parse(history.stdout) as { rows?: { status?: string; log?: string }[] }).rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0] as { status?: string; log?: string };
    expect(row.status).toBe("completed");
    expect(row.log && fs.existsSync(row.log)).toBe(true);
  });

  test("8. task run stash//tasks/manual succeeds", async () => {
    const result = await runLauncher(
      candidateLauncher,
      ["task", "run", `stash//tasks/${home.taskIds.manual}`],
      home.env,
    );
    expect(result.status, result.stderr).toBe(0);
  });

  test("9. health exits 0 or 4 and never tells an already-current install to migrate apply", async () => {
    const result = await runLauncher(candidateLauncher, ["health"], home.env);
    expect([0, 4]).toContain(result.status);
    expect(result.stdout).not.toContain("migrate apply");
  });

  test("10. improve --plan runs without an engine, or fails with the documented no-engine error (never exit 70)", async () => {
    const result = await runLauncher(candidateLauncher, ["improve", "--plan"], home.env);
    expect(result.status).not.toBe(70);
    if (result.status === 0) return;
    // Failures render to stderr as {ok:false, error, code} (AGENTS.md's CLI Contract).
    const envelope = JSON.parse(result.stderr) as { ok?: boolean; code?: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("LLM_NOT_CONFIGURED");
  });

  test("11. read-back: the OLD launcher still works against the candidate-written home", async () => {
    for (const args of [
      ["search", home.searchTerm],
      ["task", "list"],
      ["bundle", "list"],
    ] as const) {
      const result = await runLauncher(previousLauncher, [...args], home.env);
      expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
    }
    const search = await runLauncher(previousLauncher, ["search", home.searchTerm], home.env);
    const searched = JSON.parse(search.stdout) as { hits?: { ref?: string }[] };
    const ref = searched.hits?.[0]?.ref;
    expect(ref).toBeTruthy();
    const show = await runLauncher(previousLauncher, ["show", ref as string], home.env);
    expect(show.status, show.stderr).toBe(0);
  });
});
