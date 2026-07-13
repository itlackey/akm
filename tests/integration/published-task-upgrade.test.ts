// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Published-package acceptance gate for the 0.8 -> 0.9 task boundary.
 *
 * Opt in with AKM_PUBLISHED_UPGRADE_TESTS=1 and point
 * AKM_PUBLISHED_UPGRADE_TARBALL at the candidate package. The test downloads
 * published 0.8.14 and shadows crontab, so neither the real HOME nor the real
 * scheduler can be reached.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeSandboxDir } from "../_helpers/sandbox";

const ENABLED = process.env.AKM_PUBLISHED_UPGRADE_TESTS === "1" && process.platform === "linux";
const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CUSTOM_TASK_IDS = [
  "upgrade-prompt",
  "upgrade-workflow",
  "upgrade-command",
  "upgrade-disabled",
  "upgrade-explicit-improve",
  "upgrade-global-improve",
] as const;
const PUBLISHED_DEFAULT_TASK_IDS = [
  "akm-improve-frequent",
  "akm-improve-consolidate",
  "akm-improve-nightly",
  "akm-improve-catchup",
  "akm-graph-refresh-weekly",
] as const;
const PUBLISHED_CORE_TASK_IDS = ["improve", "backup"] as const;
const TASK_IDS = [...CUSTOM_TASK_IDS, ...PUBLISHED_DEFAULT_TASK_IDS, ...PUBLISHED_CORE_TASK_IDS] as const;
const SAFE_SYNC_TASK_IDS = TASK_IDS.filter((id) => id !== "backup");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface TaskHistoryRow {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  log: string;
  target: { kind: string; engine?: string | null; legacyProfile?: string; ref?: string };
  detail?: { runId?: string; exitCode?: number };
}

function run(argv: string[], env: NodeJS.ProcessEnv, timeout = 120_000): RunResult {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

function expectSuccess(result: RunResult, label: string): void {
  expect(result.status, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

function snapshotTasks(stashDir: string): Map<string, string> {
  return new Map(TASK_IDS.map((id) => [id, fs.readFileSync(path.join(stashDir, "tasks", `${id}.yml`), "utf8")]));
}

function expectTasksUnchanged(stashDir: string, original: ReadonlyMap<string, string>): void {
  for (const id of TASK_IDS) {
    const expected = original.get(id);
    if (!expected) throw new Error(`Missing original task snapshot for ${id}`);
    expect(fs.readFileSync(path.join(stashDir, "tasks", `${id}.yml`), "utf8"), `${id} was rewritten`).toBe(expected);
  }
}

function cronBody(crontab: string, id: string): string {
  const lines = crontab.split(/\r?\n/);
  const begin = lines.indexOf(`# akm:task ${id} BEGIN`);
  const end = lines.indexOf(`# akm:task ${id} END`);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBe(begin + 2);
  return lines[begin + 1];
}

function commandFromCronBody(body: string, id: string): string {
  const match = body.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
  if (!match) throw new Error(`Could not extract generated cron command for ${id}: ${body}`);
  return match[1];
}

function generatedCronCommand(crontab: string, id: string): string {
  return commandFromCronBody(cronBody(crontab, id), id);
}

function generatedDisabledCronCommand(crontab: string, id: string): string {
  const prefix = "# akm:disabled ";
  const body = cronBody(crontab, id);
  expect(body.startsWith(prefix), `${id} must not be an executable crontab line`).toBe(true);
  return commandFromCronBody(body.slice(prefix.length), id);
}

function readLatestHistory(currentCli: string, id: string, env: NodeJS.ProcessEnv): TaskHistoryRow {
  const history = run([currentCli, "tasks", "history", "--id", id, "--limit", "1"], env);
  expectSuccess(history, `read ${id} task history`);
  const parsed = JSON.parse(history.stdout) as { rows: TaskHistoryRow[] };
  expect(parsed.rows).toHaveLength(1);
  expect(parsed.rows[0].id).toBe(id);
  return parsed.rows[0];
}

function executableDir(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (fs.existsSync(path.join(dir, name))) return dir;
  }
  throw new Error(`Required executable ${name} was not found on PATH`);
}

test.skipIf(!ENABLED)(
  "published 0.8.14 tasks survive canonical migration and execute packed 0.9 scheduler output",
  () => {
    const tarball = path.resolve(process.env.AKM_PUBLISHED_UPGRADE_TARBALL ?? "");
    const expectedVersion = process.env.AKM_CANDIDATE_VERSION;
    expect(
      process.env.AKM_PUBLISHED_UPGRADE_TARBALL,
      "AKM_PUBLISHED_UPGRADE_TARBALL must name the package candidate",
    ).toBeTruthy();
    expect(fs.existsSync(tarball), `Package candidate does not exist: ${tarball}`).toBe(true);

    const sandbox = makeSandboxDir("akm-published-task-upgrade");
    const root = sandbox.dir;
    try {
      const oldPrefix = path.join(root, "old-prefix");
      const currentPrefix = path.join(root, "current-prefix");
      const home = path.join(root, "home");
      const configHome = path.join(root, "config");
      const dataHome = path.join(root, "data");
      const cacheHome = path.join(root, "cache");
      const stateHome = path.join(root, "state");
      const stashDir = path.join(root, "stash");
      const fakeBin = path.join(root, "fake-bin");
      const fakeCrontab = path.join(root, "crontab");
      const npmCache = path.join(root, "npm-cache");
      const fakeAgentBin = path.join(fakeBin, "fake-local-agent");
      for (const dir of [
        oldPrefix,
        currentPrefix,
        home,
        path.join(configHome, "akm"),
        dataHome,
        cacheHome,
        stateHome,
        stashDir,
        fakeBin,
        npmCache,
      ]) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const npmEnv = { ...process.env, npm_config_cache: npmCache };
      const oldInstall = run(
        [
          "npm",
          "install",
          "--prefix",
          oldPrefix,
          "--ignore-scripts",
          "--omit=optional",
          "--no-audit",
          "--no-fund",
          "akm-cli@0.8.14",
        ],
        npmEnv,
      );
      expectSuccess(oldInstall, "install published akm-cli@0.8.14");

      const currentInstall = run(
        [
          "npm",
          "install",
          "--prefix",
          currentPrefix,
          "--ignore-scripts",
          "--omit=optional",
          "--no-audit",
          "--no-fund",
          tarball,
        ],
        npmEnv,
      );
      expectSuccess(currentInstall, "install packed current artifact");
      const currentPackageRoot = path.join(currentPrefix, "node_modules", "akm-cli");
      const candidatePackage = JSON.parse(fs.readFileSync(path.join(currentPackageRoot, "package.json"), "utf8")) as {
        version: string;
      };
      if (expectedVersion) expect(candidatePackage.version).toBe(expectedVersion);
      else expect(candidatePackage.version).toMatch(/^0\.9\./);

      const crontabBin = path.join(fakeBin, "crontab");
      fs.writeFileSync(
        crontabBin,
        [
          "#!/bin/sh",
          `if [ "\${1:-}" = "-l" ]; then`,
          '  if [ -f "$FAKE_CRONTAB" ]; then cat "$FAKE_CRONTAB"; exit 0; fi',
          '  echo "no crontab for sandbox" >&2',
          "  exit 1",
          "fi",
          `if [ "\${1:-}" = "-" ]; then cp /dev/stdin "$FAKE_CRONTAB"; exit 0; fi`,
          "exit 2",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        fakeAgentBin,
        ["#!/bin/sh", 'printf "%s\\n" "fake-local-agent:ok"', 'printf "%s\\n" "$*"', ""].join("\n"),
        { mode: 0o755 },
      );

      const configPath = path.join(configHome, "akm", "config.json");
      const oldConfig = `${JSON.stringify({
        configVersion: "0.8.0",
        stashDir,
        sources: [],
        semanticSearchMode: "off",
        profiles: { agent: { "legacy-agent": { platform: "opencode", bin: "not-used" } } },
        defaults: { agent: "legacy-agent" },
      })}\n`;
      fs.writeFileSync(configPath, oldConfig, { mode: 0o600 });
      const oldInstallPath = [
        fakeBin,
        path.join(oldPrefix, "node_modules", ".bin"),
        path.dirname(process.execPath),
        "/usr/bin",
        "/bin",
      ].join(path.delimiter);
      const storageEnv = {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
        AKM_STASH_DIR: stashDir,
        FAKE_CRONTAB: fakeCrontab,
        NO_COLOR: "1",
      };
      const oldEnv = { ...storageEnv, PATH: oldInstallPath };
      const oldCli = path.join(oldPrefix, "node_modules", "akm-cli", "dist", "cli.js");

      const workflowPath = path.join(stashDir, "workflows", "upgrade-noop.md");
      fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
      fs.writeFileSync(
        workflowPath,
        "# Workflow: Published Upgrade Noop\n\n## Step: Only\nStep ID: only\n\n### Instructions\nStart this deterministic local workflow without external access.\n",
      );

      const oldAdds = [
        ["upgrade-prompt", "--prompt", "Review the published upgrade", "--profile", "legacy-agent"],
        ["upgrade-workflow", "--workflow", "workflow:upgrade-noop", "--params", '{"source":"published"}'],
        ["upgrade-command", "--command", "akm --version"],
        ["upgrade-disabled", "--command", "akm --version", "--disabled"],
        ["upgrade-explicit-improve", "--command", "/opt/retained-0.8/akm improve --profile frequent"],
        ["upgrade-global-improve", "--command", "akm --no-quiet --verbose=false improve --profile frequent"],
      ];
      for (const [id, ...args] of oldAdds) {
        const add = run([process.execPath, oldCli, "tasks", "add", id, "--schedule", "@daily", ...args], oldEnv);
        expectSuccess(add, `published 0.8.14 tasks add ${id}`);
      }

      const initDefaults = run([process.execPath, oldCli, "tasks", "init", "--server"], oldEnv);
      expectSuccess(initDefaults, "published 0.8.14 tasks init --server");
      const oldPackageRoot = path.join(oldPrefix, "node_modules", "akm-cli");
      for (const id of PUBLISHED_CORE_TASK_IDS) {
        fs.copyFileSync(
          path.join(oldPackageRoot, "dist", "assets", "tasks", "core", `${id}.yml`),
          path.join(stashDir, "tasks", `${id}.yml`),
        );
      }
      const oldSync = run([process.execPath, oldCli, "tasks", "sync"], oldEnv);
      expectSuccess(oldSync, "published 0.8.14 tasks sync including core templates");

      const originalTasks = snapshotTasks(stashDir);
      expect(originalTasks.get("upgrade-prompt")).toContain("profile: legacy-agent");
      expect(originalTasks.get("upgrade-workflow")).toContain("workflow: workflow:upgrade-noop");
      expect(originalTasks.get("upgrade-command")).toContain("command: akm --version");
      expect(originalTasks.get("upgrade-disabled")).toContain("enabled: false");
      expect(originalTasks.get("upgrade-explicit-improve")).toContain(
        "command: /opt/retained-0.8/akm improve --profile frequent",
      );
      expect(originalTasks.get("upgrade-global-improve")).toContain(
        "command: akm --no-quiet --verbose=false improve --profile frequent",
      );
      expect(originalTasks.get("akm-improve-frequent")).toContain(
        "command: akm improve --profile frequent --auto-accept safe",
      );
      expect(originalTasks.get("improve")).toBe(
        fs.readFileSync(path.join(oldPackageRoot, "dist", "assets", "tasks", "core", "improve.yml"), "utf8"),
      );
      expect(originalTasks.get("backup")).toBe(
        fs.readFileSync(path.join(oldPackageRoot, "dist", "assets", "tasks", "core", "backup.yml"), "utf8"),
      );
      expect(originalTasks.get("backup")).toContain("command: akm db backups\nenabled: true");
      for (const definition of originalTasks.values()) expect(definition).not.toMatch(/^version:/m);

      const oldRun = run([process.execPath, oldCli, "tasks", "run", "upgrade-command"], oldEnv);
      expectSuccess(oldRun, "published 0.8.14 task run before migration");
      const oldHistoryResult = run(
        [process.execPath, oldCli, "tasks", "history", "--id", "upgrade-command", "--limit", "1"],
        oldEnv,
      );
      expectSuccess(oldHistoryResult, "published 0.8.14 task history before migration");
      const oldHistory = (JSON.parse(oldHistoryResult.stdout) as { rows: TaskHistoryRow[] }).rows[0];
      expect(oldHistory).toMatchObject({ id: "upgrade-command", status: "completed", detail: { exitCode: 0 } });
      const oldHistoryLog = fs.readFileSync(oldHistory.log, "utf8");
      expect(oldHistoryLog).toContain("0.8.14");

      const oldDataDir = path.join(dataHome, "akm");
      const backupModule = path.join(oldPackageRoot, "dist", "indexer", "db", "db-backup.js");
      const seedBackup = run(
        [
          process.execPath,
          "--input-type=module",
          "-e",
          [
            `const { backupDataDir } = await import(${JSON.stringify(pathToFileURL(backupModule).href)});`,
            `const result = backupDataDir({ dataDir: ${JSON.stringify(oldDataDir)}, sourceVersion: 17, targetVersion: 18, now: () => new Date("2026-01-02T03:04:05.000Z") });`,
            "if (!result) throw new Error('published backupDataDir did not create a backup');",
            "process.stdout.write(JSON.stringify(result));",
          ].join("\n"),
        ],
        oldEnv,
      );
      expectSuccess(seedBackup, "seed a backup through published 0.8.14 backupDataDir");
      const legacyBackupPath = (JSON.parse(seedBackup.stdout) as { path: string }).path;
      const listedBackups = run([process.execPath, oldCli, "db", "backups"], oldEnv);
      expectSuccess(listedBackups, "published 0.8.14 db backups lists the seeded backup");
      expect(
        (JSON.parse(listedBackups.stdout) as { backups: Array<{ path: string }> }).backups.some(
          (entry) => entry.path === legacyBackupPath,
        ),
      ).toBe(true);
      const legacyBackupMetadata = fs.readFileSync(path.join(legacyBackupPath, "backup.meta.json"), "utf8");
      const legacyBackupState = fs.readFileSync(path.join(legacyBackupPath, "state.db"));

      const preparedPath = path.join(root, "prepared-0.9.json");
      const preparedConfig = {
        configVersion: "0.9.0",
        stashDir,
        sources: [],
        semanticSearchMode: "off",
        engines: { "legacy-agent": { kind: "agent", platform: "opencode", bin: fakeAgentBin } },
        defaults: { engine: "legacy-agent" },
      };
      fs.writeFileSync(preparedPath, `${JSON.stringify(preparedConfig, null, 2)}\n`, { mode: 0o600 });

      const currentCli = path.join(currentPackageRoot, "dist", "akm");
      const currentInstallPath = [
        fakeBin,
        path.join(currentPrefix, "node_modules", ".bin"),
        path.dirname(process.execPath),
        executableDir("node"),
        "/usr/bin",
        "/bin",
      ].join(path.delimiter);
      const currentEnv = { ...storageEnv, PATH: currentInstallPath };

      const status = run([currentCli, "migrate", "status", "--config", preparedPath], currentEnv);
      expectSuccess(status, "packed 0.9 migrate status");
      const statusJson = JSON.parse(status.stdout) as {
        status: string;
        artifacts: { config: { status: string }; state: { status: string } };
        targetConfig: { source: string; path: string };
      };
      expect(statusJson).toMatchObject({
        status: "ready",
        artifacts: { config: { status: "old" }, state: { status: "old" } },
        targetConfig: { source: "prepared", path: preparedPath },
      });
      expectTasksUnchanged(stashDir, originalTasks);

      const apply = run([currentCli, "migrate", "apply", "--config", preparedPath], currentEnv);
      expectSuccess(apply, "packed 0.9 migrate apply");
      const applyJson = JSON.parse(apply.stdout) as { status: string; backupPath: string; backupRunId: string };
      expect(applyJson.status).toBe("current");
      expect(path.basename(applyJson.backupPath)).toBe(applyJson.backupRunId);
      expect(applyJson.backupPath).toStartWith(path.join(dataHome, "akm", "backups", "migrations"));
      expect(fs.readFileSync(path.join(applyJson.backupPath, "config.json"), "utf8")).toBe(oldConfig);
      const manifest = JSON.parse(fs.readFileSync(path.join(applyJson.backupPath, "manifest.json"), "utf8")) as {
        complete: boolean;
        artifacts: Record<string, { status: string; present: boolean }>;
      };
      expect(manifest.complete).toBe(true);
      expect(manifest.artifacts["config.json"]).toMatchObject({ status: "old", present: true });
      expect(manifest.artifacts["state.db"]).toMatchObject({ status: "old", present: true });
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject(preparedConfig);
      expectTasksUnchanged(stashDir, originalTasks);
      expect(fs.readFileSync(path.join(legacyBackupPath, "backup.meta.json"), "utf8")).toBe(legacyBackupMetadata);
      expect(fs.readFileSync(path.join(legacyBackupPath, "state.db"))).toEqual(legacyBackupState);

      const migratedOldHistory = readLatestHistory(currentCli, "upgrade-command", currentEnv);
      expect(migratedOldHistory).toMatchObject({
        id: oldHistory.id,
        status: oldHistory.status,
        startedAt: oldHistory.startedAt,
        finishedAt: oldHistory.finishedAt,
        detail: { exitCode: 0 },
        // Published 0.8.14 persisted command runs as prompt rows. The migration
        // preserves that durable row but cannot infer the lost target kind.
        target: { kind: "prompt", engine: null },
      });
      expect(fs.readFileSync(migratedOldHistory.log, "utf8")).toBe(oldHistoryLog);

      const version = run([currentCli, "--version"], currentEnv);
      expectSuccess(version, "packed 0.9 --version");
      expect(version.stdout).toContain(candidatePackage.version);

      const sync = run([currentCli, "tasks", "sync"], currentEnv);
      expectSuccess(sync, "packed 0.9 tasks sync");
      const syncJson = JSON.parse(sync.stdout) as {
        installed: string[];
        updated: string[];
        unchanged: string[];
        skipped: Array<{ id: string; reason: string }>;
      };
      expect(syncJson.skipped).toHaveLength(1);
      expect(syncJson.skipped[0]).toMatchObject({ id: "backup" });
      expect(syncJson.skipped[0]?.reason).toContain("akm db backups");
      expect(syncJson.skipped[0]?.reason).toContain("akm backup create");
      expect(new Set([...syncJson.installed, ...syncJson.updated, ...syncJson.unchanged])).toEqual(
        new Set(SAFE_SYNC_TASK_IDS),
      );
      expectTasksUnchanged(stashDir, originalTasks);

      const shown = new Map<string, { enabled: boolean; target: Record<string, unknown> }>();
      for (const id of TASK_IDS) {
        const show = run([currentCli, "tasks", "show", id], currentEnv);
        expectSuccess(show, `packed 0.9 tasks show ${id}`);
        shown.set(id, JSON.parse(show.stdout) as { enabled: boolean; target: Record<string, unknown> });
      }
      expect(shown.get("upgrade-prompt")).toMatchObject({
        enabled: true,
        target: { kind: "prompt", engine: "legacy-agent" },
      });
      expect(shown.get("upgrade-workflow")).toMatchObject({
        enabled: true,
        target: { kind: "workflow", ref: "workflow:upgrade-noop", params: { source: "published" } },
      });
      expect(shown.get("upgrade-command")).toMatchObject({
        enabled: true,
        target: { kind: "command", cmd: ["akm", "--version"] },
      });
      expect(shown.get("upgrade-disabled")).toMatchObject({ enabled: false });
      expect(shown.get("upgrade-explicit-improve")).toMatchObject({
        enabled: true,
        target: {
          kind: "command",
          cmd: ["/opt/retained-0.8/akm", "improve", "--profile", "frequent"],
        },
      });
      expect(shown.get("upgrade-global-improve")).toMatchObject({
        enabled: true,
        target: {
          kind: "command",
          cmd: ["akm", "--no-quiet", "--verbose=false", "improve", "--strategy", "frequent"],
        },
      });
      expect(shown.get("akm-improve-frequent")).toMatchObject({
        enabled: true,
        target: {
          kind: "command",
          cmd: ["akm", "improve", "--strategy", "frequent", "--auto-accept", "safe"],
        },
      });
      expect(shown.get("backup")).toMatchObject({
        enabled: true,
        target: { kind: "command", cmd: ["akm", "db", "backups"] },
      });

      const crontab = fs.readFileSync(fakeCrontab, "utf8");
      expect(crontab).toContain(currentPackageRoot);
      expect(crontab).not.toContain(path.join(REPO_ROOT, "src", "cli.ts"));
      const disabledBody = cronBody(crontab, "upgrade-disabled");
      expect(disabledBody).toStartWith("# akm:disabled ");
      expect(disabledBody).toContain("tasks run upgrade-disabled");
      expect(disabledBody).toContain("--scheduled");
      expect(
        crontab
          .split(/\r?\n/)
          .filter((line) => !line.startsWith("#"))
          .some((line) => line.includes("tasks run upgrade-disabled")),
      ).toBe(false);
      expect(cronBody(crontab, "backup")).toStartWith("# akm:disabled ");

      const scheduledCommand = generatedCronCommand(crontab, "upgrade-command");
      expect(scheduledCommand).toContain(`PATH=${currentInstallPath}`);
      expect(scheduledCommand).toContain("tasks run upgrade-command");
      const scheduled = run(["/bin/sh", "-c", scheduledCommand], { ...storageEnv, PATH: "/usr/bin:/bin" });
      expectSuccess(scheduled, "execute generated packed-artifact cron command with stripped PATH");

      const commandHistory = readLatestHistory(currentCli, "upgrade-command", currentEnv);
      expect(commandHistory).toMatchObject({
        id: "upgrade-command",
        status: "completed",
        target: { kind: "command" },
        detail: { exitCode: 0 },
      });
      expect(fs.readFileSync(commandHistory.log, "utf8")).toContain(candidatePackage.version);

      const scheduledPrompt = run(["/bin/sh", "-c", generatedCronCommand(crontab, "upgrade-prompt")], {
        ...storageEnv,
        PATH: "/usr/bin:/bin",
      });
      expectSuccess(scheduledPrompt, "execute generated prompt cron command through fake local agent");
      const promptHistory = readLatestHistory(currentCli, "upgrade-prompt", currentEnv);
      expect(promptHistory).toMatchObject({
        status: "completed",
        target: { kind: "prompt", engine: "legacy-agent" },
        detail: { exitCode: 0 },
      });
      const promptLog = fs.readFileSync(promptHistory.log, "utf8");
      expect(promptLog).toContain("fake-local-agent:ok");
      expect(promptLog).toContain("Review the published upgrade");

      const scheduledWorkflow = run(["/bin/sh", "-c", generatedCronCommand(crontab, "upgrade-workflow")], {
        ...storageEnv,
        PATH: "/usr/bin:/bin",
      });
      expectSuccess(scheduledWorkflow, "execute generated deterministic no-network workflow cron command");
      const workflowHistory = readLatestHistory(currentCli, "upgrade-workflow", currentEnv);
      expect(workflowHistory).toMatchObject({
        status: "active",
        target: { kind: "workflow", ref: "workflow:upgrade-noop" },
      });
      expect(workflowHistory.detail?.runId).toBeTruthy();
      expect(fs.readFileSync(workflowHistory.log, "utf8")).toContain(
        `run_id=${workflowHistory.detail?.runId} status=active`,
      );

      const manualDisabled = run([currentCli, "tasks", "run", "upgrade-disabled"], currentEnv);
      expectSuccess(manualDisabled, "intentionally invoke disabled task manually");
      expect(JSON.parse(manualDisabled.stdout)).toMatchObject({
        result: { id: "upgrade-disabled", status: "completed", detail: { exitCode: 0 } },
      });
      const manualDisabledHistory = readLatestHistory(currentCli, "upgrade-disabled", currentEnv);
      expect(manualDisabledHistory).toMatchObject({
        status: "completed",
        target: { kind: "command" },
        detail: { exitCode: 0 },
      });
      expect(fs.readFileSync(manualDisabledHistory.log, "utf8")).toContain(candidatePackage.version);

      const scheduledDisabledCommand = generatedDisabledCronCommand(crontab, "upgrade-disabled");
      expect(scheduledDisabledCommand).toContain("tasks run upgrade-disabled --scheduled");
      const scheduledDisabled = run(["/bin/sh", "-c", scheduledDisabledCommand], {
        ...storageEnv,
        PATH: "/usr/bin:/bin",
      });
      expectSuccess(scheduledDisabled, "force backend-generated invocation to prove disabled task skips");
      const scheduledDisabledHistory = readLatestHistory(currentCli, "upgrade-disabled", currentEnv);
      expect(scheduledDisabledHistory).toMatchObject({
        status: "disabled",
        target: { kind: "command" },
      });
      expect(fs.readFileSync(scheduledDisabledHistory.log, "utf8")).toContain('task "upgrade-disabled" is disabled');
      expectTasksUnchanged(stashDir, originalTasks);
      expect(fs.readFileSync(path.join(legacyBackupPath, "backup.meta.json"), "utf8")).toBe(legacyBackupMetadata);
      expect(fs.readFileSync(path.join(legacyBackupPath, "state.db"))).toEqual(legacyBackupState);
    } finally {
      sandbox.cleanup();
    }
  },
  420_000,
);
