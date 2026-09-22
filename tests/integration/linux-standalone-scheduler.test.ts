// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Linux standalone scheduler acceptance. This gate uses a fake crontab and is
 * safe to run locally: it executes the generated cron body but never invokes
 * the host's crontab command.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STANDALONE_FROZEN_SCRIPT_ARG } from "../../src/tasks/standalone-script-entry";
import { makeSandboxDir } from "../_helpers/sandbox";

const REQUESTED = process.env.AKM_STANDALONE_SCHEDULER_TESTS === "1";
const ENABLED = REQUESTED && process.platform === "linux";

if (REQUESTED && !ENABLED) {
  throw new Error("AKM_STANDALONE_SCHEDULER_TESTS=1 requires a Linux runner");
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(argv: string[], env: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    env,
    encoding: "utf8",
    timeout: 120_000,
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

function generatedCronCommand(crontab: string, id: string): string {
  const lines = crontab.split(/\r?\n/);
  const begin = lines.indexOf(`# akm:task ${id} BEGIN`);
  const body = lines[begin + 1] ?? "";
  const match = body.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/);
  if (!match) throw new Error(`Could not extract generated cron command for ${id}: ${body}`);
  return match[1]!;
}

test.skipIf(!ENABLED)(
  "a standalone binary outside PATH installs and executes its generated cron command",
  () => {
    const candidateBinary = path.resolve(process.env.AKM_STANDALONE_TEST_BIN ?? "");
    const candidateArch = process.env.AKM_CANDIDATE_ARCH;
    const candidateVersion = process.env.AKM_CANDIDATE_VERSION;
    expect(process.env.AKM_STANDALONE_TEST_BIN, "AKM_STANDALONE_TEST_BIN must name the compiled artifact").toBeTruthy();
    expect(candidateArch, "AKM_CANDIDATE_ARCH must name the compiled artifact architecture").toBeTruthy();
    expect(candidateVersion, "AKM_CANDIDATE_VERSION must name the compiled artifact version").toBeTruthy();
    expect(candidateArch === process.arch).toBe(true);
    expect(fs.existsSync(candidateBinary)).toBe(true);

    const sandbox = makeSandboxDir("akm-linux-standalone-scheduler");
    const id = `akm-ci-linux-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const fakeBin = path.join(sandbox.dir, "fake-bin");
    const fakeCrontab = path.join(sandbox.dir, "crontab");
    const home = path.join(sandbox.dir, "home");
    const configHome = path.join(sandbox.dir, "config");
    const dataHome = path.join(sandbox.dir, "data");
    const cacheHome = path.join(sandbox.dir, "cache");
    const stateHome = path.join(sandbox.dir, "state");
    const stashDir = path.join(sandbox.dir, "stash");
    const standaloneDir = path.join(sandbox.dir, "standalone");
    const binary = path.join(standaloneDir, "akm");
    let taskAdded = false;

    for (const dir of [
      fakeBin,
      home,
      path.join(configHome, "akm"),
      dataHome,
      cacheHome,
      stateHome,
      stashDir,
      path.join(standaloneDir, "assets"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.copyFileSync(candidateBinary, binary);
    fs.chmodSync(binary, 0o755);
    const adjacentSentinel = "MUTABLE-ADJACENT-STANDALONE-MODEL-MAP-802";
    fs.writeFileSync(path.join(standaloneDir, "assets", "models.json"), adjacentSentinel);
    fs.writeFileSync(
      path.join(fakeBin, "crontab"),
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
      path.join(configHome, "akm", "config.json"),
      `${JSON.stringify({ configVersion: "0.9.0", bundles: { stash: { path: stashDir } }, defaultBundle: "stash", semanticSearchMode: "off" })}\n`,
      { mode: 0o600 },
    );

    const restrictedPath = [fakeBin, "/usr/bin", "/bin"].join(path.delimiter);
    expect(restrictedPath.split(path.delimiter)).not.toContain(path.dirname(binary));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      AKM_BUNDLE_DIR: stashDir,
      FAKE_CRONTAB: fakeCrontab,
      PATH: restrictedPath,
      NO_COLOR: "1",
      CI: "1",
    };

    try {
      const version = run([binary, "--version"], env);
      expectSuccess(version, "standalone candidate --version");
      expect(version.stdout).toContain(candidateVersion as string);

      const copiedModels = run([binary, "models", "copy-defaults"], env);
      expectSuccess(copiedModels, "standalone models copy-defaults");
      expect(copiedModels.stdout + copiedModels.stderr).not.toContain(adjacentSentinel);
      const copiedModelText = fs.readFileSync(path.join(configHome, "akm", "models.json"), "utf8");
      const authoritativeModelText = fs.readFileSync(
        path.resolve(import.meta.dir, "../../src/assets/models.json"),
        "utf8",
      );
      expect(copiedModelText).toBe(authoritativeModelText);
      const modelDocument = JSON.parse(copiedModelText) as {
        version?: number;
        aliases?: Record<string, unknown>;
      };
      expect(modelDocument.version).toBe(1);
      expect(Object.keys(modelDocument.aliases ?? {}).sort()).toEqual(["balanced", "fast", "reasoning"]);

      const doctor = run([binary, "task", "doctor"], env);
      expectSuccess(doctor, "standalone tasks doctor");
      expect(JSON.parse(doctor.stdout)).toMatchObject({ akm: { argv: [binary], via: "standalone" } });

      const add = run(
        [binary, "task", "add", id, "--schedule", "@daily", "--command", "/bin/echo standalone-cron"],
        env,
      );
      expectSuccess(add, "standalone tasks add");
      taskAdded = true;

      const taskPath = path.join(stashDir, "tasks", `${id}.yml`);
      const originalTask = fs.readFileSync(taskPath);
      const crontab = fs.readFileSync(fakeCrontab, "utf8");
      expect(crontab).toContain(binary);
      expect(crontab).not.toContain("/$bunfs/");
      expect(crontab).not.toContain("src/cli.ts");

      const scheduledCommand = generatedCronCommand(crontab, id);
      const scheduled = run(["/bin/sh", "-c", scheduledCommand], { ...env, PATH: "/usr/bin:/bin" });
      expectSuccess(scheduled, "generated standalone cron command");

      const history = run([binary, "task", "history", "--id", id, "--limit", "1"], env);
      expectSuccess(history, "standalone tasks history");
      const row = (
        JSON.parse(history.stdout) as {
          rows: Array<{ status: string; log: string; detail?: { exitCode?: number } }>;
        }
      ).rows[0];
      expect(row).toMatchObject({ status: "completed", detail: { exitCode: 0 } });
      expect(fs.readFileSync(row!.log, "utf8")).toContain("standalone-cron");
      expect(fs.readFileSync(taskPath)).toEqual(originalTask);

      fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(stashDir, "tasks"), { recursive: true });
      for (const [extension, source, marker] of [
        [
          "js",
          'if (process.argv.length !== 2 || process.argv[1] !== import.meta.path) throw new Error("bad argv"); if (import.meta.main) console.log("standalone-frozen-js")\n',
          "standalone-frozen-js",
        ],
        [
          "ts",
          'const marker: string = "standalone-frozen-ts"; if (process.argv.length !== 2 || process.argv[1] !== import.meta.path) throw new Error("bad argv"); if (import.meta.main) console.log(marker)\n',
          "standalone-frozen-ts",
        ],
      ] as const) {
        const scriptId = `compiled-${extension}`;
        fs.writeFileSync(path.join(stashDir, "scripts", `${scriptId}.${extension}`), source);
        fs.writeFileSync(
          path.join(stashDir, "tasks", `${scriptId}.yml`),
          `version: 4\nuses: scripts/${scriptId}.${extension}\n`,
        );
        const scriptRun = run([binary, "task", "run", scriptId, "--bundle", "stash"], env);
        expectSuccess(scriptRun, `compiled standalone ${extension} task`);
        const scriptResult = (
          JSON.parse(scriptRun.stdout) as {
            result: { status: string; log: string; target: { kind: string; cmd: string[] } };
          }
        ).result;
        expect(scriptResult.status).toBe("completed");
        expect(scriptResult.target.cmd.slice(0, 2)).toEqual([binary, STANDALONE_FROZEN_SCRIPT_ARG]);
        expect(fs.readFileSync(scriptResult.log, "utf8")).toContain(marker);
        expect(fs.existsSync(path.dirname(scriptResult.target.cmd.at(-1) as string))).toBe(false);
      }
    } finally {
      if (taskAdded) run([binary, "task", "remove", id], env);
      sandbox.cleanup();
    }
  },
  180_000,
);

test.skipIf(!ENABLED)("the compiled binary runs its embedded migrator exactly once per invocation", () => {
  // The migrator shim's "am I the entry module" guard fires inside a
  // single-file bundle, so a binary that imported the shim printed -- and
  // applied -- every plan twice; `akm upgrade` then read two JSON lines as a
  // failed migration. The standalone entry dispatches to the guard-free
  // module instead. This pins the observable: one plan, one line, whether
  // reached through `akm migrate` or the internal re-exec marker.
  const candidateBinary = path.resolve(process.env.AKM_STANDALONE_TEST_BIN ?? "");
  expect(fs.existsSync(candidateBinary)).toBe(true);
  const sandbox = makeSandboxDir("akm-linux-standalone-migrate");
  const configHome = path.join(sandbox.dir, "config");
  const stashDir = path.join(sandbox.dir, "stash");
  const fakeBin = path.join(sandbox.dir, "fake-bin");
  for (const dir of [
    path.join(configHome, "akm"),
    stashDir,
    fakeBin,
    path.join(sandbox.dir, "data"),
    path.join(sandbox.dir, "cache"),
    path.join(sandbox.dir, "state"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(configHome, "akm", "config.json"),
    `${JSON.stringify({ configVersion: "0.9.0", bundles: { stash: { path: stashDir } }, defaultBundle: "stash", semanticSearchMode: "off" })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "crontab"),
    ["#!/bin/sh", `if [ "\${1:-}" = "-l" ]; then echo "no crontab for sandbox" >&2; exit 1; fi`, "exit 2", ""].join(
      "\n",
    ),
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    // Migrator status now inspects native scheduler activation. Keep this
    // acceptance hermetic instead of reading the developer/CI user's real
    // crontab, which may legitimately contain enabled akm bindings.
    PATH: [fakeBin, "/usr/bin", "/bin"].join(path.delimiter),
    HOME: path.join(sandbox.dir, "home"),
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(sandbox.dir, "data"),
    XDG_CACHE_HOME: path.join(sandbox.dir, "cache"),
    XDG_STATE_HOME: path.join(sandbox.dir, "state"),
  };
  try {
    for (const [label, argv, extraEnv] of [
      ["akm migrate status", [candidateBinary, "migrate", "status"], {}],
      ["re-exec marker", [candidateBinary, "status"], { AKM_MIGRATE_ENTRY: "1" }],
    ] as const) {
      const result = run([...argv], { ...env, ...extraEnv });
      expectSuccess(result, label);
      // Exactly one JSON document: a second concatenated plan fails to parse.
      // (The wrapper pretty-prints through the output pipeline; the marker
      // path prints the migrator's own single line.)
      let plan: { status?: string; stateMigrations?: unknown };
      try {
        plan = JSON.parse(result.stdout) as typeof plan;
      } catch {
        throw new Error(`${label} did not print exactly one plan:\n${result.stdout}`);
      }
      expect(plan.status).toBe("current");
      expect(plan.stateMigrations).toEqual({ pending: [] });
      if (extraEnv.AKM_MIGRATE_ENTRY) expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }
  } finally {
    sandbox.cleanup();
  }
});
