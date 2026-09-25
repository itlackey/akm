// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * RUNTIME-03/ORG-03: this suite installs the PREVIOUS published `akm-cli`
 * release as a real global npm package (real `npm pack` / `npm install
 * --global` into a throwaway prefix), uses it to build a realistic home
 * (five bundle kinds, scheduled tasks, a synced fake crontab), then installs
 * the CANDIDATE build OVER that same prefix — an in-place swap, the same
 * thing a real `npm i -g akm-cli@…`/`bun add -g` upgrade does — and drives
 * the candidate against the home, and finally a separate untouched copy of
 * the previous release back against the candidate-written home. It shells
 * out to real `npm`/`git` subprocesses, spawns real installed binaries, and
 * serves local HTTP fixtures — it belongs in the integration target, not the
 * unit target, which must stay hermetic and host-independent.
 *
 * Gated behind `AKM_UPGRADE_REHEARSAL=1` (unset: logs one line and skips).
 * See docs/architecture/testing/testing-workflow.md's "Upgrade rehearsal
 * gate" subsection (under "Upgrade Regression Coverage") for how to run
 * this locally and its env overrides.
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
  let candidateLauncher: string;
  let livePrefix: string;
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

    // Install the previous release into TWO prefixes: `live`, which the
    // candidate is installed OVER in place below (the same prefix a real
    // `npm i -g akm-cli@…`/`bun add -g` upgrade replaces), and an untouched
    // `previous-readback` copy that step 11 drives against the
    // candidate-written home.
    const [liveInstall, previousReadbackInstall] = await Promise.all([
      installAkmTarball(previousTarball, prefixRoot, "live", previousVersion),
      installAkmTarball(previousTarball, prefixRoot, "previous-readback", previousVersion),
    ]);
    previousLauncher = previousReadbackInstall.launcher;

    home = await buildHome(liveInstall.launcher, path.join(workRoot, "home"));
    // Surfaced (not silently dropped) rather than left as an unread field.
    console.log(`upgrade-rehearsal home deviations:\n- ${home.deviations.join("\n- ")}`);

    // Install the CANDIDATE over `live`, in the SAME prefix — an in-place
    // swap, not a side-by-side install. Scheduler rows the previous release
    // wrote while building the home embed a launcher path inside `live`;
    // that path does not change across this swap, which is exactly what
    // lets step 6's plain `task sync` (no `--rebind`) leave them alone and
    // still have them run the candidate.
    const candidateInstall = await installAkmTarball(candidateTarball, prefixRoot, "live", candidateVersion);
    candidateLauncher = candidateInstall.launcher;
    livePrefix = candidateInstall.prefix;
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

  test("3. candidate migrate apply succeeds, removes experimental.workflowEngine, and status then reports current", async () => {
    const apply = await runLauncher(candidateLauncher, ["migrate", "apply"], home.env);
    expect(apply.status, apply.stderr).toBe(0);

    // `home.ts` writes `experimental.workflowEngine` into config.json to
    // model a value carried over from 0.9.15 (see its comment) — this is
    // the on-disk removal the retired-config-key read shim's warning names.
    const configAfterApply = JSON.parse(fs.readFileSync(home.configPath, "utf8")) as {
      experimental?: Record<string, unknown>;
    };
    expect(configAfterApply.experimental?.workflowEngine).toBeUndefined();

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

    // Every listed bundle must be enabled. `bundle list`'s SourceEntry shape
    // carries no `enabled` field of its own (an upgrade must not leave a
    // bundle silently disabled, but nothing in that read surface says so
    // either way) — read the field the candidate actually loaded instead:
    // `config get bundles`, keyed by bundle name, `enabled: false` only when
    // set.
    const bundlesGet = await runLauncher(candidateLauncher, ["config", "get", "bundles"], home.env);
    expect(bundlesGet.status, bundlesGet.stderr).toBe(0);
    const bundlesConfig = JSON.parse(bundlesGet.stdout) as Record<string, { enabled?: boolean } | undefined>;
    for (const name of names) {
      if (!name) continue;
      expect(bundlesConfig[name]?.enabled, `bundle ${JSON.stringify(name)}`).not.toBe(false);
    }

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

  test("6. task sync (plain, no --rebind) keeps a/b scheduled inside `live`; c stays absent", async () => {
    // Plain `task sync` is what an upgrading user actually runs — no other
    // command sits between "install the new package" and "the scheduler
    // keeps working". An installed binding whose schedule/inputs already
    // match the desired state is left exactly as recorded, not implicitly
    // repointed at whichever binary is running sync today (`--rebind` is
    // the explicit "replace installed bindings with the current invocation"
    // flag; see tasks-cli.ts) — there is nothing here for it to fix: the
    // candidate was installed OVER `live` in place, so the launcher path a/b
    // already embed still resolves inside `live` unchanged.
    const result = await runLauncher(candidateLauncher, ["task", "sync"], home.env);
    expect(result.status, result.stderr).toBe(0);

    const crontab = fs.readFileSync(home.fakeCrontab, "utf8");
    const commandA = extractCronCommandContaining(crontab, home.taskIds.a);
    const commandB = extractCronCommandContaining(crontab, home.taskIds.b);
    expect(commandA).toContain(livePrefix);
    expect(commandB).toContain(livePrefix);
    expect(crontab.includes(home.taskIds.c)).toBe(false);
  });

  test("7. the generated cron command for scheduled-a runs the CANDIDATE and writes a task log", async () => {
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

    // Prove the row that just ran was the CANDIDATE, not the previous
    // release still installed at `previous-readback`: the generated command
    // is the resolved invocation argv (one token per element — see
    // buildScheduledBindingInvocation/resolveAkmInvocation in
    // src/tasks/backends/cron.ts and src/tasks/resolve-akm-bin.ts, unquoted
    // via quoteForCron since fixture paths never contain shell-special
    // characters) followed by `task run <ref>`. Strip the `task run …` tail
    // and re-invoke the same resolved argv with `--version` instead.
    const tokens = command.split(/\s+/);
    const taskIndex = tokens.indexOf("task");
    if (taskIndex <= 0) throw new Error(`Could not find the "task" subcommand in generated command: ${command}`);
    const [rowRuntime, ...rowRuntimeArgs] = tokens.slice(0, taskIndex);
    if (!rowRuntime) throw new Error(`Could not extract an invocation from command: ${command}`);
    const version = await runLauncher(rowRuntime, [...rowRuntimeArgs, "--version"], home.env);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain(candidateVersion);
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
