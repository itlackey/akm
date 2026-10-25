// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The compiled standalone binary's first model-backed run needs no network. It
 * is built here (`scripts/build-standalone.ts`, for the host) and run with the
 * npm registry pointed at a closed port and an empty `<akm cache>/opencode/npm/`:
 * akm's runtime reaches a loopback model with the AI SDK package embedded in the
 * binary, so there is nothing for OpenCode to install. Before the package was
 * embedded this run died trying to download it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../../src/core/paths";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { makeSandboxDir, type SandboxedDir, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
// Nothing listens on the discard port: an install attempt is refused at once.
const UNREACHABLE_REGISTRY = "http://127.0.0.1:9/";

let model: FakeModelServer;
let build: SandboxedDir;
let binary: string;

beforeAll(() => {
  model = startFakeModel();
  build = makeSandboxDir("akm-standalone-build");
  binary = path.join(build.dir, process.platform === "win32" ? "akm.exe" : "akm");
  const built = spawnSync("bun", ["scripts/build-standalone.ts", "--outfile", binary, "--version", "0.0.0-test"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (built.status !== 0) throw new Error(`the standalone build failed:\n${built.stdout}\n${built.stderr}`);
}, 200_000);

afterAll(() => {
  model.stop();
  build.cleanup();
});

/** The binary run to completion without blocking this process, which is serving the model it talks to. */
function runBinary(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("the standalone binary", () => {
  test("runs on akm's own runtime offline, with nothing downloaded and the package cache empty", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({
        semanticSearchMode: "off",
        connections: { default: { endpoint: model.url, models: { fast: "fake-model", balanced: "fake-model" } } },
      });
      const npmCache = path.join(getCacheDir(), "opencode", "npm");
      expect(fs.existsSync(npmCache)).toBe(false);

      const run = await runBinary(["agent", "--prompt", "MODE:answer ping"], {
        ...process.env,
        npm_config_registry: UNREACHABLE_REGISTRY,
        NPM_CONFIG_REGISTRY: UNREACHABLE_REGISTRY,
        BUN_CONFIG_REGISTRY: UNREACHABLE_REGISTRY,
      });

      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      const result = JSON.parse(run.stdout) as { ok: boolean; stdout: string; stderr: string };
      expect(result.ok).toBe(true);
      expect(result.stdout).toMatch(/^ANSWER-\d+$/);
      expect(result.stderr).toBe("");
      expect(model.requests.at(-1)?.mode).toBe("answer");
      // OpenCode installed nothing: no package was asked for, so its cache was not even made.
      expect(fs.existsSync(npmCache) ? fs.readdirSync(npmCache) : []).toEqual([]);
    } finally {
      storage.cleanup();
    }
  }, 120_000);
});
