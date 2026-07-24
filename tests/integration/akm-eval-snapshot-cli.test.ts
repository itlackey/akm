// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const WRAPPER = path.join(REPO_ROOT, "scripts", "akm-eval", "bin", "akm-eval-snapshot");
const cleanups: Array<() => void> = [];

interface SnapshotFixture {
  root: string;
  home: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  xdgStateHome: string;
  configPath: string;
  dataDir: string;
  personalBundle: string;
  teamBundle?: string;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function privateDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function privateFile(filePath: string, contents: string): void {
  privateDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function createDatabase(filePath: string): void {
  privateDirectory(path.dirname(filePath));
  const database = new Database(filePath);
  try {
    database.exec("CREATE TABLE snapshot_probe (value TEXT NOT NULL)");
    database.prepare("INSERT INTO snapshot_probe (value) VALUES (?)").run(path.basename(filePath));
  } finally {
    database.close();
  }
  fs.chmodSync(filePath, 0o600);
}

function createFixture(withRemoteBundle = false): SnapshotFixture {
  const sandbox = makeSandboxDir("akm-eval-snapshot-cli");
  cleanups.push(sandbox.cleanup);
  const root = sandbox.dir;
  const home = privateDirectory(path.join(root, "home"));
  const xdgConfigHome = privateDirectory(path.join(root, "xdg-config"));
  const xdgDataHome = privateDirectory(path.join(root, "xdg-data"));
  const xdgCacheHome = privateDirectory(path.join(root, "xdg-cache"));
  const xdgStateHome = privateDirectory(path.join(root, "xdg-state"));
  const configPath = path.join(xdgConfigHome, "akm", "config.json");
  const dataDir = privateDirectory(path.join(xdgDataHome, "akm"));
  const personalBundle = privateDirectory(path.join(root, "bundles", "personal"));
  privateFile(path.join(personalBundle, "memories", "preference.md"), "prefer focused tests\n");

  let teamBundle: string | undefined;
  const bundles: Record<string, unknown> = {
    personal: { path: personalBundle, writable: true },
  };
  if (withRemoteBundle) {
    teamBundle = privateDirectory(path.join(root, "materialized", "team"));
    privateFile(path.join(teamBundle, "skills", "review.md"), "review carefully\n");
    bundles.team = { git: "https://example.test/private-team.git" };
  }

  privateFile(
    configPath,
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaultBundle: "personal",
      bundles,
    })}\n`,
  );
  createDatabase(path.join(dataDir, "index.db"));
  createDatabase(path.join(dataDir, "state.db"));

  // A broken HOME config proves that XDG/AKM path resolution never falls back to it.
  privateFile(path.join(home, ".config", "akm", "config.json"), "not valid json\n");
  return {
    root,
    home,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
    configPath,
    dataDir,
    personalBundle,
    teamBundle,
  };
}

function fixtureEnv(fixture: SnapshotFixture): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: fixture.home,
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    XDG_DATA_HOME: fixture.xdgDataHome,
    XDG_CACHE_HOME: fixture.xdgCacheHome,
    XDG_STATE_HOME: fixture.xdgStateHome,
  };
}

function run(args: string[], env: Record<string, string>) {
  return Bun.spawnSync([WRAPPER, ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("akm-eval-snapshot CLI", () => {
  test("captures configured and overridden bundles, verifies the result, and never overwrites it", () => {
    const fixture = createFixture(true);
    const snapshotDir = path.join(fixture.root, "snapshot");
    const capture = run(
      [
        "capture",
        "--out",
        snapshotDir,
        "--config",
        fixture.configPath,
        "--data",
        fixture.dataDir,
        "--bundle",
        `team=${fixture.teamBundle}`,
        "--producer-version",
        "0.9.0-test",
        "--producer-commit",
        "abc123",
      ],
      fixtureEnv(fixture),
    );

    expect(capture.exitCode).toBe(0);
    expect(capture.stderr.toString()).toBe("");
    const manifest = JSON.parse(capture.stdout.toString()) as Record<string, unknown>;
    expect(manifest.producer).toEqual({ version: "0.9.0-test", commit: "abc123" });
    expect(Object.keys(manifest.bundleRoots as Record<string, string>).sort()).toEqual(["personal", "team"]);
    expect(capture.stdout.toString()).not.toContain(fixture.personalBundle);
    expect(capture.stdout.toString()).not.toContain("example.test");

    const verify = run(["verify", snapshotDir], fixtureEnv(fixture));
    expect(verify.exitCode).toBe(0);
    expect(verify.stderr.toString()).toBe("");
    expect(JSON.parse(verify.stdout.toString())).toEqual(manifest);

    const before = fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8");
    const overwrite = run(
      [
        "capture",
        "--out",
        snapshotDir,
        "--config",
        fixture.configPath,
        "--data",
        fixture.dataDir,
        "--bundle",
        `team=${fixture.teamBundle}`,
        "--producer-version",
        "replacement",
      ],
      fixtureEnv(fixture),
    );
    expect(overwrite.exitCode).toBe(2);
    expect(overwrite.stdout.toString()).toBe("");
    expect(overwrite.stderr.toString()).toContain("must not already exist");
    expect(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8")).toBe(before);
  });

  test("uses isolated XDG defaults and honors AKM config/data overrides", () => {
    const fixture = createFixture();
    const xdgSnapshot = path.join(fixture.root, "xdg-snapshot");
    const xdgCapture = run(
      ["capture", "--out", xdgSnapshot, "--producer-version", "xdg-defaults"],
      fixtureEnv(fixture),
    );
    expect(xdgCapture.exitCode).toBe(0);
    expect((JSON.parse(xdgCapture.stdout.toString()) as { producer: unknown }).producer).toEqual({
      version: "xdg-defaults",
      commit: null,
    });

    const overrideSnapshot = path.join(fixture.root, "override-snapshot");
    const overrideEnv = {
      ...fixtureEnv(fixture),
      AKM_CONFIG_DIR: path.dirname(fixture.configPath),
      AKM_DATA_DIR: fixture.dataDir,
      XDG_CONFIG_HOME: path.join(fixture.root, "missing-xdg-config"),
      XDG_DATA_HOME: path.join(fixture.root, "missing-xdg-data"),
    };
    const overrideCapture = run(
      ["capture", "--out", overrideSnapshot, "--producer-version", "akm-overrides"],
      overrideEnv,
    );
    expect(overrideCapture.exitCode).toBe(0);
    expect(overrideCapture.stderr.toString()).toBe("");
    expect((JSON.parse(overrideCapture.stdout.toString()) as { producer: unknown }).producer).toEqual({
      version: "akm-overrides",
      commit: null,
    });
  });

  test("requires explicit roots for non-filesystem bundles and rejects unknown override IDs", () => {
    const fixture = createFixture(true);
    const baseArgs = [
      "capture",
      "--out",
      path.join(fixture.root, "snapshot"),
      "--config",
      fixture.configPath,
      "--data",
      fixture.dataDir,
      "--producer-version",
      "test",
    ];

    const missing = run(baseArgs, fixtureEnv(fixture));
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout.toString()).toBe("");
    expect(missing.stderr.toString()).toContain("team uses a non-filesystem provider");
    expect(missing.stderr.toString()).toContain("--bundle team=<path>");

    const unknown = run([...baseArgs, "--bundle", `other=${fixture.teamBundle}`], fixtureEnv(fixture));
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout.toString()).toBe("");
    expect(unknown.stderr.toString()).toContain("unknown configured bundle: other");
  });

  test("rejects duplicate, malformed, unknown, and missing arguments with exit 2", () => {
    const sandbox = makeSandboxDir("akm-eval-snapshot-cli-args");
    cleanups.push(sandbox.cleanup);
    const out = path.join(sandbox.dir, "snapshot");
    const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
    const cases: Array<{ args: string[]; message: string }> = [
      {
        args: ["capture", "--out", out, "--producer-version", "test", "--bundle", "team=/one", "--bundle", "team=/two"],
        message: "duplicate --bundle override for team",
      },
      {
        args: ["capture", "--out", out, "--producer-version", "test", "--bundle", "bad/id=/one"],
        message: "invalid bundle ID",
      },
      {
        args: ["capture", "--out", out, "--producer-version", "test", "--bundle", "team="],
        message: "--bundle must use id=path",
      },
      {
        args: ["capture", "--out", out, "--producer-version", "test", "--unknown"],
        message: "unknown argument for capture",
      },
      { args: ["capture", "--producer-version", "test"], message: "capture requires --out" },
      { args: ["capture", "--out", out], message: "capture requires --producer-version" },
      { args: ["verify"], message: "verify requires one snapshot directory" },
      { args: ["verify", "/one", "/two"], message: "verify requires exactly one snapshot directory" },
      { args: ["verify", "--unknown"], message: "unknown argument for verify" },
      { args: ["unknown"], message: "unknown subcommand" },
    ];

    for (const item of cases) {
      const result = run(item.args, env);
      expect(result.exitCode, item.args.join(" ")).toBe(2);
      expect(result.stdout.toString(), item.args.join(" ")).toBe("");
      expect(result.stderr.toString(), item.args.join(" ")).toContain(item.message);
    }
  });

  test("help works without HOME or any AKM/XDG state", () => {
    const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
    for (const args of [["--help"], ["capture", "--help"], ["verify", "--help"]]) {
      const result = run(args, env);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).toContain("Usage:");
    }
  });
});
