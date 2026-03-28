/**
 * Docker install tests — verify akm installs and works on various OS configurations.
 *
 * These tests build Docker images for each OS/install-method combination and run
 * the smoke-test.sh script inside them. They require Docker to be available.
 *
 * Run:
 *   bun test tests/docker-install.test.ts
 *
 * Or run the shell orchestrator directly:
 *   ./tests/docker/run-docker-tests.sh
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const DOCKER_DIR = path.join(PROJECT_ROOT, "tests", "docker");
const BUILD_DIR = path.join(DOCKER_DIR, ".build");
const TIMEOUT = 300_000; // 5 minutes per container build+run

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return r.status === 0;
}

function bunAvailable(): boolean {
  const r = spawnSync("bun", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return r.status === 0;
}

function buildBinary(): boolean {
  spawnSync("mkdir", ["-p", BUILD_DIR]);
  const r = spawnSync(
    "bun",
    ["build", "./src/cli.ts", "--compile", "--target=bun-linux-x64", "--outfile", path.join(BUILD_DIR, "akm")],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return r.status === 0;
}

function dockerBuild(variant: string): { ok: boolean; output: string } {
  const dockerfile = path.join(DOCKER_DIR, `Dockerfile.${variant}`);
  const tag = `akm-test-${variant}`;
  const r = spawnSync("docker", ["build", "-f", dockerfile, "-t", tag, PROJECT_ROOT], {
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  return {
    ok: r.status === 0,
    output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
  };
}

function dockerRun(variant: string): { ok: boolean; output: string } {
  const tag = `akm-test-${variant}`;
  const r = spawnSync("docker", ["run", "--rm", tag], {
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  return {
    ok: r.status === 0,
    output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
  };
}

const HAS_DOCKER = dockerAvailable();
const HAS_BUN = bunAvailable();

const bunVariants = ["ubuntu-bun", "debian-bun", "alpine-bun", "fedora-bun"] as const;

const binaryVariants = ["ubuntu-binary", "debian-binary", "alpine-binary", "fedora-binary"] as const;

// Cleanup build artifacts after all tests
afterAll(() => {
  spawnSync("rm", ["-rf", BUILD_DIR]);
});

describe.skipIf(!HAS_DOCKER || !HAS_BUN || !!process.env.CI)("Docker install tests", () => {
  describe("bun install method", () => {
    for (const variant of bunVariants) {
      const os = variant.replace("-bun", "");
      test(
        `${os}: bun install → init → index → search`,
        () => {
          const build = dockerBuild(variant);
          if (!build.ok) {
            throw new Error(`Docker build failed:\n${build.output}`);
          }

          const run = dockerRun(variant);
          if (!run.ok) {
            throw new Error(`Smoke test failed:\n${run.output}`);
          }
          expect(run.output).toContain("All tests passed");
        },
        TIMEOUT,
      );
    }
  });

  describe("binary install method", () => {
    let binaryBuilt = false;

    test("build akm linux-x64 binary", () => {
      binaryBuilt = buildBinary();
      expect(binaryBuilt).toBe(true);
    }, 120_000);

    for (const variant of binaryVariants) {
      const os = variant.replace("-binary", "");
      test(
        `${os}: binary install → init → index → search`,
        () => {
          if (!binaryBuilt) {
            throw new Error("Binary build must succeed first");
          }

          const build = dockerBuild(variant);
          if (!build.ok) {
            throw new Error(`Docker build failed:\n${build.output}`);
          }

          const run = dockerRun(variant);
          if (!run.ok) {
            throw new Error(`Smoke test failed:\n${run.output}`);
          }
          expect(run.output).toContain("All tests passed");
        },
        TIMEOUT,
      );
    }
  });
});
