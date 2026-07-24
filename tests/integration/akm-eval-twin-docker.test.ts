import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const LAUNCHER = path.join(PROJECT_ROOT, "scripts", "akm-eval", "bin", "akm-eval-twin-docker");
const DOCKERFILE = path.join(PROJECT_ROOT, "scripts", "akm-eval", "Dockerfile.twin");

interface Fixture {
  root: string;
  binDir: string;
  logPath: string;
  snapshot: string;
  out: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const sandbox = makeSandboxDir("akm-eval-twin-docker");
  const binDir = path.join(sandbox.dir, "bin");
  const snapshot = path.join(sandbox.dir, "snapshot");
  const out = path.join(sandbox.dir, "out");
  const logPath = path.join(sandbox.dir, "docker-argv");
  fs.mkdirSync(binDir);
  fs.mkdirSync(snapshot);
  fs.mkdirSync(out);
  const docker = path.join(binDir, "docker");
  fs.writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -euo pipefail
command_name="$1"
shift
printf '%s\\0' "$command_name" "$@" > "\${FAKE_DOCKER_LOG}.\${command_name}"
if [[ "$command_name" == "build" ]]; then
  context="\${!#}"
  printf '%s\\n' "$context" > "\${FAKE_DOCKER_LOG}.build-context"
  stat -c '%a' "$context" > "\${FAKE_DOCKER_LOG}.build-context-mode"
  printf '%s\\0' "$context"/* > "\${FAKE_DOCKER_LOG}.build-context-entries"
  for entry in package.json bun.lock tsconfig.json tsconfig.build.json schemas src scripts; do
    [[ -e "$context/$entry" ]] || exit 20
  done
  if [[ -n "\${FAKE_DOCKER_SENTINEL:-}" && -e "$context/\${FAKE_DOCKER_SENTINEL}" ]]; then
    printf 'present\\n' > "\${FAKE_DOCKER_LOG}.build-context-sentinel"
  else
    printf 'absent\\n' > "\${FAKE_DOCKER_LOG}.build-context-sentinel"
  fi
  [[ "\${FAKE_DOCKER_FAIL_BUILD:-0}" != "1" ]] || exit 42
fi
if [[ "$command_name" == "run" && -f "\${FAKE_DOCKER_LOG}.build-context" ]]; then
  IFS= read -r context < "\${FAKE_DOCKER_LOG}.build-context"
  if [[ -d "$context" ]]; then
    printf 'present\\n' > "\${FAKE_DOCKER_LOG}.run-build-context"
  else
    printf 'absent\\n' > "\${FAKE_DOCKER_LOG}.run-build-context"
  fi
fi
`,
    { mode: 0o755 },
  );
  return { root: sandbox.dir, binDir, logPath, snapshot, out, cleanup: sandbox.cleanup };
}

function runLauncher(fixture: Fixture, args: string[], envOverrides: Record<string, string | undefined> = {}) {
  const env = {
    ...process.env,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    FAKE_DOCKER_LOG: fixture.logPath,
    ...envOverrides,
  };
  return spawnSync(LAUNCHER, args, { cwd: PROJECT_ROOT, env, encoding: "utf8" });
}

function readDockerArgs(fixture: Fixture, command: "build" | "run"): string[] {
  const values = fs.readFileSync(`${fixture.logPath}.${command}`, "utf8").split("\0");
  values.pop();
  return values;
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function mountFor(args: string[], target: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--mount" && args[index + 1]?.includes(`target=${target}`)) return args[index + 1];
  }
  return undefined;
}

describe("akm-eval-twin-docker", () => {
  test("builds the workspace image and rewrites all mounted paths", () => {
    const fixture = makeFixture();
    const sentinelName = `.akm-eval-twin-context-sentinel-${path.basename(fixture.root)}`;
    const sentinel = path.join(PROJECT_ROOT, sentinelName);
    try {
      const metadata = path.join(fixture.root, "endpoint.json");
      const runtime = path.join(fixture.root, "runtime.json");
      const commonRuntime = path.join(fixture.root, "common-runtime.json");
      const assignment = path.join(fixture.root, "assignment.json");
      const cases = path.join(fixture.root, "cases");
      fs.mkdirSync(cases, { mode: 0o700 });
      fs.writeFileSync(metadata, "{}\n");
      fs.writeFileSync(runtime, "{}\n", { mode: 0o600 });
      fs.writeFileSync(commonRuntime, "{}\n", { mode: 0o600 });
      fs.writeFileSync(assignment, "[]\n");
      fs.writeFileSync(sentinel, "private workspace sentinel\n");

      const secret = "must-not-enter-container";
      const result = runLauncher(
        fixture,
        [
          "--snapshot",
          fixture.snapshot,
          "--out",
          fixture.out,
          "--suite",
          "improve-smoke",
          "--cases-dir",
          cases,
          "--endpoint-metadata",
          metadata,
          "--endpoint-runtime",
          runtime,
          "--common-runtime",
          commonRuntime,
          "--endpoint-assignment",
          assignment,
          "--minimum-deterministic-lift",
          "0",
        ],
        {
          AKM_EVAL_TWIN_ALLOW_TMP_MOUNTS: "1",
          AKM_EVAL_TWIN_DOCKER_IMAGE: "example/akm-twin:test",
          AKM_EVAL_TWIN_DOCKER_NETWORK: "eval-network",
          AKM_EVAL_TWIN_SKIP_BUILD: "0",
          FAKE_DOCKER_SENTINEL: sentinelName,
          SECRET_TOKEN: secret,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const buildContext = fs.readFileSync(`${fixture.logPath}.build-context`, "utf8").trim();
      expect(readDockerArgs(fixture, "build")).toEqual([
        "build",
        "--file",
        path.join(buildContext, "scripts", "akm-eval", "Dockerfile.twin"),
        "--tag",
        "example/akm-twin:test",
        buildContext,
      ]);
      expect(buildContext).not.toBe(PROJECT_ROOT);
      expect(fs.readFileSync(`${fixture.logPath}.build-context-mode`, "utf8").trim()).toBe("700");
      expect(
        fs
          .readFileSync(`${fixture.logPath}.build-context-entries`, "utf8")
          .split("\0")
          .filter(Boolean)
          .map((entry) => path.basename(entry))
          .sort(),
      ).toEqual(["bun.lock", "package.json", "schemas", "scripts", "src", "tsconfig.build.json", "tsconfig.json"]);
      expect(fs.readFileSync(`${fixture.logPath}.build-context-sentinel`, "utf8").trim()).toBe("absent");
      expect(fs.readFileSync(`${fixture.logPath}.run-build-context`, "utf8").trim()).toBe("present");
      expect(fs.existsSync(buildContext)).toBe(false);
      expect(fs.existsSync(sentinel)).toBe(true);

      const run = readDockerArgs(fixture, "run");
      expect(run[0]).toBe("run");
      expect(run).toContain("--rm");
      if (!process.getuid || !process.getgid) throw new Error("Docker launcher test requires POSIX user IDs");
      expect(optionValue(run, "--user")).toBe(`${process.getuid()}:${process.getgid()}`);
      expect(optionValue(run, "--network")).toBe("eval-network");
      expect(run).toContain("example/akm-twin:test");
      expect(optionValue(run, "--snapshot")).toBe("/akm-eval/snapshot");
      expect(optionValue(run, "--out")).toBe("/akm-eval/out");
      expect(optionValue(run, "--cases-dir")).toBe("/akm-eval/cases");
      expect(optionValue(run, "--endpoint-metadata")).toBe("/akm-eval/inputs/endpoint-metadata-001.json");
      expect(optionValue(run, "--endpoint-runtime")).toBe("/akm-eval/inputs/endpoint-runtime-001.json");
      expect(optionValue(run, "--common-runtime")).toBe("/akm-eval/inputs/common-runtime-001.json");
      expect(optionValue(run, "--endpoint-assignment")).toBe("/akm-eval/inputs/endpoint-assignment-001.json");
      expect(optionValue(run, "--akm")).toBe("bun /app/dist/cli.js");

      expect(mountFor(run, "/akm-eval/snapshot")).toBe(
        `type=bind,source=${fs.realpathSync(fixture.snapshot)},target=/akm-eval/snapshot,readonly`,
      );
      expect(mountFor(run, "/akm-eval/out")).toBe(
        `type=bind,source=${fs.realpathSync(fixture.out)},target=/akm-eval/out`,
      );
      expect(mountFor(run, "/akm-eval/cases")).toBe(
        `type=bind,source=${fs.realpathSync(cases)},target=/akm-eval/cases,readonly`,
      );
      expect(mountFor(run, "/akm-eval/inputs/endpoint-metadata-001.json")).toEndWith(
        "target=/akm-eval/inputs/endpoint-metadata-001.json,readonly",
      );
      expect(mountFor(run, "/akm-eval/inputs/endpoint-runtime-001.json")).toEndWith(
        "target=/akm-eval/inputs/endpoint-runtime-001.json,readonly",
      );
      expect(mountFor(run, "/akm-eval/inputs/common-runtime-001.json")).toEndWith(
        "target=/akm-eval/inputs/common-runtime-001.json,readonly",
      );
      expect(mountFor(run, "/akm-eval/inputs/endpoint-assignment-001.json")).toEndWith(
        "target=/akm-eval/inputs/endpoint-assignment-001.json,readonly",
      );
      expect(run.some((arg) => arg === "-e" || arg === "--env" || arg.startsWith("--env="))).toBe(false);
      expect(run).not.toContain(secret);
    } finally {
      fs.rmSync(sentinel, { force: true });
      fixture.cleanup();
    }
  });

  test("Dockerfile copies only allowlisted build-context entries", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    expect(dockerfile).toContain("FROM oven/bun:1.3.13@sha256:");
    expect(dockerfile).not.toMatch(/^COPY \. \.?$/m);
    expect(dockerfile).toContain("COPY package.json bun.lock ./");
    expect(dockerfile).toContain("COPY tsconfig.json tsconfig.build.json ./");
    expect(dockerfile).toContain("COPY schemas/ ./schemas/");
    expect(dockerfile).toContain("COPY src/ ./src/");
    expect(dockerfile).toContain("COPY scripts/ ./scripts/");
  });

  test("cleans the temporary context when the image build fails", () => {
    const fixture = makeFixture();
    try {
      const result = runLauncher(fixture, ["--snapshot", fixture.snapshot, "--out", fixture.out], {
        AKM_EVAL_TWIN_ALLOW_TMP_MOUNTS: "1",
        FAKE_DOCKER_FAIL_BUILD: "1",
      });
      expect(result.status).toBe(42);
      const buildContext = fs.readFileSync(`${fixture.logPath}.build-context`, "utf8").trim();
      expect(fs.existsSync(buildContext)).toBe(false);
      expect(fs.existsSync(`${fixture.logPath}.run`)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects caller-owned --akm", () => {
    const fixture = makeFixture();
    try {
      const result = runLauncher(fixture, ["--akm", "other-akm"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--akm is owned by this launcher");
      expect(fs.existsSync(`${fixture.logPath}.build`)).toBe(false);
      expect(fs.existsSync(`${fixture.logPath}.run`)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    { name: "snapshot", args: (fixture: Fixture) => ["--out", fixture.out], message: "--snapshot is required" },
    {
      name: "output",
      args: (fixture: Fixture) => ["--snapshot", fixture.snapshot],
      message: "--out is required",
    },
  ])("requires $name", ({ args, message }) => {
    const fixture = makeFixture();
    try {
      const result = runLauncher(fixture, args(fixture), { AKM_EVAL_TWIN_ALLOW_TMP_MOUNTS: "1" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects temporary bind sources unless explicitly overridden", () => {
    const fixture = makeFixture();
    try {
      const rejected = runLauncher(fixture, ["--snapshot", fixture.snapshot, "--out", fixture.out]);
      expect(rejected.status).toBe(2);
      expect(rejected.stderr).toContain("refusing temporary bind source");

      const allowed = runLauncher(fixture, ["--snapshot", fixture.snapshot, "--out", fixture.out], {
        AKM_EVAL_TWIN_ALLOW_TMP_MOUNTS: "1",
        AKM_EVAL_TWIN_SKIP_BUILD: "1",
      });
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(fs.existsSync(`${fixture.logPath}.build`)).toBe(false);
      expect(fs.existsSync(`${fixture.logPath}.run`)).toBe(true);
      expect(readDockerArgs(fixture, "run")).not.toContain("--network");
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects overlapping snapshot and output paths", () => {
    const fixture = makeFixture();
    try {
      const result = runLauncher(
        fixture,
        ["--snapshot", fixture.snapshot, "--out", path.join(fixture.snapshot, "results")],
        { AKM_EVAL_TWIN_ALLOW_TMP_MOUNTS: "1" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--snapshot and --out must not overlap");
      expect(fs.existsSync(path.join(fixture.snapshot, "results"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    {
      name: "snapshot",
      args: (fixture: Fixture) => ["--snapshot", path.join(PROJECT_ROOT, "src"), "--out", fixture.out],
    },
    {
      name: "output",
      args: (fixture: Fixture) => [
        "--snapshot",
        fixture.snapshot,
        "--out",
        path.join(PROJECT_ROOT, `.akm-eval-twin-out-${path.basename(fixture.root)}`),
      ],
    },
    {
      name: "cases directory",
      args: (fixture: Fixture) => [
        "--snapshot",
        fixture.snapshot,
        "--out",
        fixture.out,
        "--cases-dir",
        path.join(PROJECT_ROOT, "scripts", "akm-eval", "cases"),
      ],
    },
    {
      name: "endpoint metadata",
      args: (fixture: Fixture) => [
        "--snapshot",
        fixture.snapshot,
        "--out",
        fixture.out,
        "--endpoint-metadata",
        path.join(PROJECT_ROOT, "package.json"),
      ],
    },
    {
      name: "endpoint runtime",
      args: (fixture: Fixture) => [
        "--snapshot",
        fixture.snapshot,
        "--out",
        fixture.out,
        "--endpoint-runtime",
        path.join(PROJECT_ROOT, "package.json"),
      ],
    },
    {
      name: "common runtime",
      args: (fixture: Fixture) => [
        "--snapshot",
        fixture.snapshot,
        "--out",
        fixture.out,
        "--common-runtime",
        path.join(PROJECT_ROOT, "package.json"),
      ],
    },
    {
      name: "endpoint assignment",
      args: (fixture: Fixture) => [
        "--snapshot",
        fixture.snapshot,
        "--out",
        fixture.out,
        "--endpoint-assignment",
        path.join(PROJECT_ROOT, "package.json"),
      ],
    },
  ])("rejects $name paths inside the workspace before Docker", ({ args }) => {
    const fixture = makeFixture();
    try {
      const result = runLauncher(fixture, args(fixture), { AKM_EVAL_TWIN_ALLOW_TMP_MOUNTS: "1" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("must be outside the workspace");
      expect(fs.existsSync(`${fixture.logPath}.build`)).toBe(false);
      expect(fs.existsSync(`${fixture.logPath}.run`)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("prints help without Docker", () => {
    const fixture = makeFixture();
    try {
      const result = spawnSync("/bin/bash", [LAUNCHER, "--help"], {
        cwd: PROJECT_ROOT,
        env: { PATH: `${fixture.binDir}:/usr/bin:/bin` },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("AKM_EVAL_TWIN_DOCKER_IMAGE");
      expect(result.stdout).toContain("AKM_EVAL_TWIN_DOCKER_NETWORK");
      expect(fs.existsSync(`${fixture.logPath}.build`)).toBe(false);
      expect(fs.existsSync(`${fixture.logPath}.run`)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
