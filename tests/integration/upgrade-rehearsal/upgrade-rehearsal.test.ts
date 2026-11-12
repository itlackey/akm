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
import { gte as semverGte } from "semver";
import { openDatabase } from "../../../src/storage/database";
import { resolveCandidateTarball } from "./candidate";
import { requireUpgradeRehearsalCapabilities } from "./gate";
import { buildHome, type UpgradeHome } from "./home";
import { installAkmTarball, runLauncher } from "./install";
import { fetchPreviousReleaseTarball, resolveUpgradeOriginVersion, type UpgradeOrigin } from "./previous-release";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const REQUESTED = process.env.AKM_UPGRADE_REHEARSAL === "1";
// The CI matrix (.github/workflows/ci.yml's upgrade-rehearsal job) runs each
// KNOWN_UPGRADE_ORIGINS entry in its own parallel job by setting this to one
// origin; unset (local dev) runs every origin's describe block in this one
// process, same as before this filter existed.
// The first release that records CLI usage in metrics.db (`cli_usage_*`).
const CLI_USAGE_CAPTURE_SINCE = "0.10.261119";
const ORIGIN_FILTER = process.env.AKM_UPGRADE_REHEARSAL_ORIGIN?.trim();

if (!REQUESTED) {
  console.log("AKM_UPGRADE_REHEARSAL is not set to 1 — skipping the upgrade rehearsal gate.");
}

function skipOrigin(origin: UpgradeOrigin): boolean {
  return !REQUESTED || (Boolean(ORIGIN_FILTER) && ORIGIN_FILTER !== origin);
}

requireUpgradeRehearsalCapabilities({
  requested: REQUESTED,
  npmAvailable: Bun.which("npm") !== null,
  candidateTarballProvided: Boolean(process.env.AKM_CANDIDATE_TARBALL?.trim()),
  distCliExists: fs.existsSync(path.join(REPO_ROOT, "dist", "cli.js")),
});

/** The first file called `name` under `dir`, or undefined. */
function findFile(dir: string, name: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return undefined;
}

function candidatePackageVersion(): string {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  const version = (JSON.parse(raw) as { version?: string }).version;
  if (!version) throw new Error("package.json has no version");
  return version;
}

/** A row's command without the leading `NAME=value` assignments it sets for itself. */
function withoutAssignments(words: string[]): string[] {
  const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return start === -1 ? [] : words.slice(start);
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

for (const origin of ["previous", "0.9.32"] as const) {
  describe.skipIf(skipOrigin(origin))(`upgrade rehearsal: candidate against a ${origin}-built home`, () => {
    let workRoot: string;
    let previousVersion: string;
    let previousLauncher: string;
    let candidateLauncher: string;
    let livePrefix: string;
    let candidateVersion: string;
    let home: UpgradeHome;
    /** `migrate apply`'s plan, from test 3. */
    let applied: { assetEngineKeys?: { notes?: string[] }; assetContentRefs?: { stateRows?: number } };

    beforeAll(async () => {
      workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-upgrade-rehearsal-"));
      const cacheRoot = path.join(os.tmpdir(), "akm-upgrade-rehearsal");
      fs.mkdirSync(cacheRoot, { recursive: true });

      candidateVersion = candidatePackageVersion();
      previousVersion = await resolveUpgradeOriginVersion(origin, candidateVersion);

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
      // candidate-written home. One after the other: onnxruntime-node's
      // postinstall extracts into a tmpdir named only by `Date.now()`, so two
      // concurrent installs can share it and one deletes the other's files.
      const liveInstall = await installAkmTarball(previousTarball, prefixRoot, "live", previousVersion);
      const previousReadbackInstall = await installAkmTarball(
        previousTarball,
        prefixRoot,
        "previous-readback",
        previousVersion,
      );
      previousLauncher = previousReadbackInstall.launcher;

      home = await buildHome(liveInstall.launcher, liveInstall.version, path.join(workRoot, "home"));
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

    test("0. scheduled-a's old cron row (`--scheduled`) survives the upgrade with no manual step: run as cron runs it, before any `migrate` call, it runs the candidate, completes, and writes a task log", async () => {
      // Runs BEFORE test 2/3's own `migrate status`/`apply` calls: a scheduled
      // task must survive an upgrade by ANY install method with no human ever
      // running `akm migrate apply` first — the old rows keep firing, and the
      // candidate reads what the old release wrote, until the first `task sync`
      // (or `migrate apply`) replaces them with the one dispatch entry.
      const crontab = fs.readFileSync(home.fakeCrontab, "utf8");
      expect(crontab).toContain("--scheduled");
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

      // Prove the row that just ran was the CANDIDATE, not the previous release still installed at
      // `previous-readback`: the row's command is the resolved launcher argv followed by `task run <id>`. Strip
      // that tail and re-invoke the same launcher with `--version`.
      const tokens = withoutAssignments(command.split(/\s+/));
      const taskIndex = tokens.indexOf("task");
      if (taskIndex <= 0) throw new Error(`Could not find the "task" subcommand in generated command: ${command}`);
      const [rowRuntime, ...rowRuntimeArgs] = tokens.slice(0, taskIndex);
      if (!rowRuntime) throw new Error(`Could not extract an invocation from command: ${command}`);
      const version = await runLauncher(rowRuntime, [...rowRuntimeArgs, "--version"], home.env);
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout).toContain(candidateVersion);
    });

    test("1. candidate --version prints the candidate version", async () => {
      const result = await runLauncher(candidateLauncher, ["--version"], home.env);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(candidateVersion);
    });

    test("2. candidate migrate status is current or ready with no blockers", async () => {
      const result = await runLauncher(candidateLauncher, ["migrate", "status"], home.env);
      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout) as {
        status?: string;
        blockers?: string[];
        scheduler?: { entry?: string; removedLegacy?: string[]; keptLegacy?: unknown[] };
      };
      expect(["current", "ready"]).toContain(plan.status ?? "");
      expect(plan.blockers ?? []).toEqual([]);
      // Read-only: the plan says the one entry would replace both of the previous release's rows; the crontab is untouched.
      expect(plan.scheduler).toMatchObject({ entry: "installed", keptLegacy: [] });
      expect([...(plan.scheduler?.removedLegacy ?? [])].sort()).toEqual([home.taskIds.a, home.taskIds.b].sort());
      expect(fs.readFileSync(home.fakeCrontab, "utf8")).not.toContain("akm:dispatch");
    });

    test("2b. before `migrate apply` the origin model config loads; only the 0.9 engines form is named, and it is not converted", async () => {
      const info = await runLauncher(candidateLauncher, ["info"], home.env);
      expect(info.status, info.stderr).toBe(0);
      const warnings = info.stderr.split("\n").filter((line) => line.includes("is the retired engines form"));
      if (origin === "0.9.32") expect(home.modelConfig.legacyEngines).toBeDefined();
      // One warning per retired key (`engines`, `defaults`), each naming the command that converts it.
      expect(warnings).toHaveLength(home.modelConfig.legacyEngines ? 2 : 0);
      for (const warning of warnings) expect(warning).toContain("akm migrate apply");
      const rows = (JSON.parse(info.stdout) as { connectionsAndHarnesses?: { type?: string; name?: string }[] })
        .connectionsAndHarnesses;
      const named = (rows ?? []).filter((row) => row.name).map((row) => `${row.type} ${row.name}`);
      // The 0.9 form yields nothing until it is migrated. The `opencode-sdk` engine `defaults.engine` named is the
      // user's own OpenCode: after the migration, the harness called `default`.
      expect(named).toEqual(
        home.modelConfig.legacyEngines ? [] : ["connection default", "harness claude", "harness default"],
      );
    });

    test("3. candidate migrate apply succeeds, removes experimental.workflowEngine, and status then reports current", async () => {
      // What the origin wrote under the loose file's old spelling (`knowledge/reports/<name>`), read before the
      // migration: a release that already spells the ref by path leaves nothing to re-key.
      const seeded = findFile(home.env.XDG_DATA_HOME ?? "", "state.db");
      expect(seeded).toBeDefined();
      const seededDb = openDatabase(seeded as string, { readonly: true });
      let oldSpellingRows: number;
      try {
        const row = seededDb
          .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE entry_ref LIKE ?")
          .get(`%knowledge/reports/${home.looseName}`) as { n: number };
        oldSpellingRows = row.n;
      } finally {
        seededDb.close();
      }
      // The 0.9 origin spells it the old way, so the re-key must be proven there.
      if (origin === "0.9.32") expect(oldSpellingRows).toBeGreaterThanOrEqual(1);

      const apply = await runLauncher(candidateLauncher, ["migrate", "apply"], home.env);
      expect(apply.status, apply.stderr).toBe(0);
      applied = JSON.parse(apply.stdout) as typeof applied & {
        scheduler?: { entry?: string; removedLegacy?: string[]; keptLegacy?: unknown[] };
      };

      // The feedback the previous release recorded under the loose file's old spelling (`knowledge/reports/<name>`)
      // is re-keyed by this step, not by the index.
      // `stateRows` also counts rows in other state tables, so it is at least the usage rows seen before, and
      // zero when the origin wrote none in the old spelling.
      const stateRows = applied.assetContentRefs?.stateRows ?? 0;
      if (oldSpellingRows === 0) expect(stateRows).toBe(0);
      else expect(stateRows).toBeGreaterThanOrEqual(oldSpellingRows);

      // `migrate apply` also runs `task sync`: the one entry replaces every row of the previous release, in the
      // crontab write that installs it, so nothing fires twice.
      const scheduler = (
        applied as { scheduler?: { entry?: string; removedLegacy?: string[]; keptLegacy?: unknown[] } }
      ).scheduler;
      expect(scheduler).toMatchObject({ entry: "installed", keptLegacy: [] });
      expect([...(scheduler?.removedLegacy ?? [])].sort()).toEqual([home.taskIds.a, home.taskIds.b].sort());
      const replaced = fs.readFileSync(home.fakeCrontab, "utf8");
      expect((replaced.match(/# akm:dispatch BEGIN/g) ?? []).length).toBe(1);
      expect(replaced).not.toContain("# akm:task");
      expect(replaced).not.toContain("# akm:env");
      expect(replaced).not.toContain("--scheduled");
      expect(replaced).not.toContain(home.taskIds.c);

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

    test("3b. migrate apply preserves native model config, or converts engines, files the key, moves models.json and rewrites assets with a flag migration note", async () => {
      const config = JSON.parse(fs.readFileSync(home.configPath, "utf8")) as Record<string, unknown>;
      expect(config.engines).toBeUndefined();
      expect(config.defaults).toBeUndefined();
      expect(Object.keys((config.connections ?? {}) as object)).toEqual(["default"]);
      const harnesses = (config.harnesses ?? {}) as Record<
        string,
        { platform?: string; models?: Record<string, unknown> }
      >;
      expect(Object.keys(harnesses)).toEqual(["claude", "default"]);
      expect(harnesses.default?.platform).toBe("opencode");
      expect(harnesses.default?.models?.balanced).toBe("openai/gpt-rehearsal");

      const legacy = home.modelConfig.legacyEngines;
      if (legacy) {
        // The key left `apiKeyFile` for credentials.json. Compared, never printed.
        const credentials = JSON.parse(
          fs.readFileSync(path.join(path.dirname(home.configPath), "credentials.json"), "utf8"),
        ) as { connections?: Record<string, { key?: string }> };
        expect(credentials.connections?.default?.key === legacy.key).toBe(true);
        expect(fs.existsSync(legacy.modelsFile)).toBe(false);
        expect(applied.assetEngineKeys?.notes?.join("\n")).toContain("--engine lab is now --connection default");
      } else {
        expect(config.connections).toEqual({
          default: { endpoint: "http://127.0.0.1:9/v1/chat/completions", models: { balanced: "qwen3-8b" } },
        });
        expect(config.harnesses).toEqual({
          claude: { platform: "claude" },
          default: { platform: "opencode", models: { balanced: "openai/gpt-rehearsal" } },
        });
      }

      for (const file of [home.modelConfig.commandFile, home.modelConfig.taskFile]) {
        const text = fs.readFileSync(file, "utf8");
        expect(text, file).toContain("connection: default");
        expect(text, file).not.toContain("engine:");
      }
      // Converted once: the next load has nothing to warn about.
      const info = await runLauncher(candidateLauncher, ["info"], home.env);
      expect(info.status, info.stderr).toBe(0);
      expect(info.stderr).not.toContain("is the retired engines form");
    });

    test("4. core read surfaces succeed: config get, bundle list, info, search, show, search --type task", async () => {
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
      const searched = JSON.parse(search.stdout) as { results?: { ref?: string }[] };
      expect(searched.results?.length ?? 0).toBeGreaterThan(0);
      const ref = searched.results?.[0]?.ref;
      expect(ref).toBeTruthy();

      const show = await runLauncher(candidateLauncher, ["show", ref as string], home.env);
      expect(show.status, show.stderr).toBe(0);

      const taskList = await runLauncher(candidateLauncher, ["search", "--type", "task"], home.env);
      expect(taskList.status, taskList.stderr).toBe(0);
    });

    test("5. task sync after migrate apply has nothing left to do: a plain sync reports the entry unchanged and leaves the crontab byte-identical", async () => {
      const before = fs.readFileSync(home.fakeCrontab, "utf8");
      const result = await runLauncher(candidateLauncher, ["task", "sync"], home.env);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ entry: "unchanged", removedLegacy: [], keptLegacy: [] });
      expect(fs.readFileSync(home.fakeCrontab, "utf8")).toBe(before);
    });

    test("6. the entry names the CANDIDATE inside `live`, with the PATH it was written from", async () => {
      const crontab = fs.readFileSync(home.fakeCrontab, "utf8");
      const lines = crontab.split(/\r?\n/);
      const begin = lines.indexOf("# akm:dispatch BEGIN");
      expect(begin).toBeGreaterThan(-1);
      const block = lines.slice(begin, lines.indexOf("# akm:dispatch END") + 1);
      expect(block.some((line) => line.startsWith("PATH="))).toBe(true);
      const entry = block.find((line) => line.startsWith("* * * * * ")) as string;
      expect(entry).toContain(livePrefix);
      expect(entry).toContain("task dispatch");
      // The crontab's own lines (the fake crontab the home was built against) are still there, untouched.
      expect(crontab.indexOf("# akm:dispatch BEGIN")).toBe(crontab.lastIndexOf("# akm:dispatch BEGIN"));
      const command = entry.slice("* * * * * ".length).replace(/ > .*$/, "");
      const [runtime, ...args] = command.split(/\s+/).slice(0, -2);
      const version = await runLauncher(runtime as string, [...args, "--version"], home.env);
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout).toContain(candidateVersion);
    });

    test("7. the entry, run as cron runs it, starts a due task detached, and the task completes with a log", async () => {
      const id = "rehearsal-every-minute";
      const added = await runLauncher(
        candidateLauncher,
        ["task", "add", id, "--schedule", "* * * * *", "--command", "echo dispatched-by-the-entry"],
        home.env,
      );
      expect(added.status, added.stderr).toBe(0);

      const crontab = fs.readFileSync(home.fakeCrontab, "utf8");
      const line = crontab.split(/\r?\n/).find((candidate) => candidate.startsWith("* * * * * ")) as string;
      const command = line.slice("* * * * * ".length);
      const dispatched = await runLauncher("/bin/sh", ["-c", command], home.env);
      expect(dispatched.status, dispatched.stderr).toBe(0);

      const deadline = Date.now() + 60_000;
      let row: { status?: string; log?: string } | undefined;
      while (Date.now() < deadline) {
        const history = await runLauncher(candidateLauncher, ["task", "history", id, "--limit", "1"], home.env);
        row = (JSON.parse(history.stdout || '{"rows":[]}') as { rows?: { status?: string; log?: string }[] }).rows?.[0];
        if (row && row.status !== "active") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(row?.status).toBe("completed");
      expect(row?.log && fs.readFileSync(row.log, "utf8")).toContain("dispatched-by-the-entry");
    });

    test("8. task run stash//tasks/manual succeeds", async () => {
      // The manual task was already run once by the PREVIOUS release (home.ts
      // "Index, remember, search, and run the manual task"). Read that row
      // back through the CANDIDATE before running it again here, to prove the
      // candidate can decode a task_history row the previous release wrote.
      const priorHistory = await runLauncher(
        candidateLauncher,
        ["task", "history", `stash//tasks/${home.taskIds.manual}`, "--limit", "1"],
        home.env,
      );
      expect(priorHistory.status, priorHistory.stderr).toBe(0);
      const priorRows = (JSON.parse(priorHistory.stdout) as { rows?: { status?: string }[] }).rows ?? [];
      expect(priorRows.length).toBeGreaterThan(0);
      expect(priorRows[0]?.status).toBe("completed");

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

    test("10. improve --dry-run runs without an engine, or fails with the documented no-engine error (never exit 70)", async () => {
      const result = await runLauncher(candidateLauncher, ["improve", "--dry-run"], home.env);
      expect(result.status).not.toBe(70);
      if (result.status === 0) return;
      // Failures render to stderr as {ok:false, error, code}.
      const envelope = JSON.parse(result.stderr) as { ok?: boolean; code?: string };
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("LLM_NOT_CONFIGURED");
    });

    test("10b. a file outside its type folder takes its path as its ref, keeps the feedback recorded under the old spelling, and the old spelling still shows it", async () => {
      const indexed = await runLauncher(candidateLauncher, ["index"], home.env);
      expect(indexed.status, indexed.stderr).toBe(0);
      const byPath = await runLauncher(candidateLauncher, ["show", `reports/${home.looseName}`], home.env);
      expect(byPath.status, byPath.stderr).toBe(0);
      const bySpelling = await runLauncher(
        candidateLauncher,
        ["show", `knowledge/reports/${home.looseName}`],
        home.env,
      );
      expect(bySpelling.status, bySpelling.stderr).toBe(0);
      expect(bySpelling.stderr).toMatch(/outdated/);

      const stateDb = findFile(home.env.XDG_DATA_HOME ?? "", "state.db");
      expect(stateDb).toBeDefined();
      const db = openDatabase(stateDb as string, { readonly: true });
      try {
        const refs = (
          db.prepare("SELECT DISTINCT entry_ref AS ref FROM usage_events WHERE signal = 'positive'").all() as {
            ref: string;
          }[]
        ).map((row) => row.ref);
        expect(refs).toContain(`stash//reports/${home.looseName}`);
        expect(refs).not.toContain(`stash//knowledge/reports/${home.looseName}`);
      } finally {
        db.close();
      }
    });

    test("10c. the first `akm index` after the upgrade folds every closed day already in state.db into metrics.db, and purges only the aged-out usage rows", async () => {
      const stateDbPath = findFile(home.env.XDG_DATA_HOME ?? "", "state.db") as string;
      expect(stateDbPath).toBeDefined();
      const dayAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      const seed = openDatabase(stateDbPath);
      try {
        for (const days of [200, 100, 3]) {
          seed
            .prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES ('health_probe', ?, NULL, '{}')")
            .run(dayAgo(days));
          seed
            .prepare("INSERT INTO usage_events (event_type, entry_ref, created_at) VALUES ('show', 'stash//a', ?)")
            .run(dayAgo(days).slice(0, 19).replace("T", " "));
          seed
            .prepare(
              `INSERT INTO improve_runs (id, started_at, completed_at, stash_dir, dry_run, strategy, scope_mode, ok, result_json)
               VALUES (?, ?, ?, '/s', 0, 'default', 'all', 1, '{"schemaVersion":2,"strategyFilteredRefs":[{"ref":"a"}]}')`,
            )
            .run(`rehearsal-${days}`, dayAgo(days), dayAgo(days));
        }
      } finally {
        seed.close();
      }
      // Every closed day state.db holds before the fold: what the first fold has to cover.
      const readDays = (db: ReturnType<typeof openDatabase>, table: string, column: string) =>
        (
          db
            .prepare(`SELECT DISTINCT substr(${column}, 1, 10) AS day FROM ${table} WHERE ${column} < ?`)
            .all(new Date().toISOString().slice(0, 10)) as { day: string }[]
        ).map((row) => row.day);
      const before = openDatabase(stateDbPath, { readonly: true });
      const expectedDays = new Set([
        ...readDays(before, "events", "ts"),
        ...readDays(before, "usage_events", "created_at"),
        ...readDays(before, "improve_runs", "started_at"),
      ]);
      before.close();
      expect(expectedDays.size).toBeGreaterThanOrEqual(3);

      const indexed = await runLauncher(candidateLauncher, ["index"], home.env);
      expect(indexed.status, indexed.stderr).toBe(0);

      const metricsPath = findFile(home.env.XDG_DATA_HOME ?? "", "metrics.db");
      expect(metricsPath, "akm index created metrics.db").toBeDefined();
      const metrics = openDatabase(metricsPath as string, { readonly: true });
      try {
        const folded = (metrics.prepare("SELECT day FROM folded_day").all() as { day: string }[]).map((r) => r.day);
        expect(new Set(folded)).toEqual(expectedDays);
        const run = metrics.prepare("SELECT result_json FROM improve_runs WHERE id = 'rehearsal-200'").get() as {
          result_json: string;
        };
        expect(JSON.parse(run.result_json)).toEqual({ schemaVersion: 2, strategyFilteredCount: 1 });
      } finally {
        metrics.close();
      }
      // The purged days still count: the three seeded shows are in the report, two of them from metrics.db.
      const report = await runLauncher(candidateLauncher, ["metrics", "--since", "400d"], home.env);
      expect(report.status, report.stderr).toBe(0);
      const metricsReport = JSON.parse(report.stdout) as {
        usage?: { totals?: { shows?: number }; daily?: { day: string; show: number }[] };
        notes?: string[];
      };
      const shownDays = new Set((metricsReport.usage?.daily ?? []).filter((d) => d.show > 0).map((d) => d.day));
      for (const days of [200, 100, 3]) expect(shownDays.has(dayAgo(days).slice(0, 10)), `${days}d ago`).toBe(true);
      expect(metricsReport.notes?.join("\n")).toContain("daily rollups");

      const after = openDatabase(stateDbPath, { readonly: true });
      try {
        const left = (
          after.prepare("SELECT created_at FROM usage_events WHERE entry_ref = 'stash//a'").all() as {
            created_at: string;
          }[]
        ).map((row) => row.created_at.slice(0, 10));
        expect(left.sort()).toEqual([dayAgo(3).slice(0, 10)]);
      } finally {
        after.close();
      }
    });

    test("11. read-back: the OLD launcher still works against the candidate-written home", async () => {
      for (const args of [
        ["search", home.searchTerm],
        ["search", "--type", "task"],
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

    test("11b. read-back of rows only the candidate writes: task_history `trigger`, usage-event `agent` metadata, and CLI usage in metrics.db", async () => {
      const taskRef = `stash//tasks/${home.taskIds.manual}`;
      const taskRun = await runLauncher(candidateLauncher, ["task", "run", taskRef], home.env);
      expect(taskRun.status, taskRun.stderr).toBe(0);
      const search = await runLauncher(candidateLauncher, ["search", home.searchTerm], home.env);
      const ref = (JSON.parse(search.stdout) as { results?: { ref?: string }[] }).results?.[0]?.ref as string;
      expect(ref, search.stdout).toBeTruthy();
      const agentShow = await runLauncher(candidateLauncher, ["show", ref], {
        ...home.env,
        CLAUDE_CODE_SESSION_ID: "rehearsal-session",
      });
      expect(agentShow.status, agentShow.stderr).toBe(0);

      // Read back, with the candidate's own code, that the candidate really wrote the new fields.
      const stateDbPath = findFile(home.env.XDG_DATA_HOME ?? "", "state.db") as string;
      const metricsDbPath = path.join(path.dirname(stateDbPath), "metrics.db");
      const db = openDatabase(stateDbPath, { readonly: true });
      let newestStartedAt: string;
      try {
        const row = db
          .prepare(
            "SELECT started_at, metadata_json FROM task_history WHERE task_id LIKE ? ORDER BY started_at DESC LIMIT 1",
          )
          .get(`%${home.taskIds.manual}`) as { started_at: string; metadata_json: string } | undefined;
        expect(row, "candidate task_history row").toBeDefined();
        expect(JSON.parse(row?.metadata_json ?? "{}").trigger).toBe("manual");
        newestStartedAt = row?.started_at as string;
        const usage = db
          .prepare("SELECT metadata FROM usage_events WHERE event_type = 'show' ORDER BY id DESC LIMIT 1")
          .get() as { metadata: string };
        expect(JSON.parse(usage.metadata).agent).toEqual({ harness: "claude", session: "rehearsal-session" });
      } finally {
        db.close();
      }
      const cliUsageRows = () => {
        const metrics = openDatabase(metricsDbPath, { readonly: true });
        try {
          return (metrics.prepare("SELECT COUNT(*) AS n FROM cli_usage_invocations").get() as { n: number }).n;
        } finally {
          metrics.close();
        }
      };
      const usageBefore = cliUsageRows();
      expect(usageBefore).toBeGreaterThan(0);

      // The previous release reads the same home: it decodes those rows (no skip warning) and sees the
      // candidate's newest task run. A release before CLI usage capture leaves the usage tables alone;
      // one with capture (0.10.261119+) adds exactly its own two invocations to the same schema.
      const history = await runLauncher(previousLauncher, ["task", "history", taskRef, "--limit", "1"], home.env);
      expect(history.status, history.stderr).toBe(0);
      expect(history.stderr).not.toMatch(/Skipping unparseable/);
      const rows = (JSON.parse(history.stdout) as { rows?: { startedAt?: string }[] }).rows ?? [];
      expect(rows[0]?.startedAt).toBe(newestStartedAt);
      const previousShow = await runLauncher(previousLauncher, ["show", ref], home.env);
      expect(previousShow.status, previousShow.stderr).toBe(0);
      expect(previousShow.stderr).not.toMatch(/Skipping unparseable/);
      expect(cliUsageRows()).toBe(usageBefore + (semverGte(previousVersion, CLI_USAGE_CAPTURE_SINCE) ? 2 : 0));
    });
  });
}
