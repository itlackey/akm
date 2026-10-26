// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The compiled standalone binary's first run of akm's own runtime. The runtime is
 * a pinned OpenCode binary fetched once into akm's cache, so the test links the one
 * it fetched for the suite (`tests/_helpers/opencode-binary.ts`) where akm looks and
 * runs the standalone with the npm registry pointed at a closed port: nothing is
 * fetched, and nothing is downloaded for the provider, which the OpenCode binary
 * bundles. The plugin that gives the agent akm's tools is the one embedded in the
 * standalone, and the tool call goes back into the standalone itself.
 *
 * The standalone is built here (`scripts/build-standalone.ts`, for the host). The
 * suite is skipped, with a message, when the OpenCode binary cannot be fetched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir, getDataDir } from "../../src/core/paths";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { fetchSharedOpencode, linkSharedOpencode } from "../_helpers/opencode-binary";
import { makeSandboxDir, type SandboxedDir, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
// Nothing listens on the discard port: an install attempt is refused at once.
const UNREACHABLE_REGISTRY = "http://127.0.0.1:9/";

const unavailable = await fetchSharedOpencode();
if (unavailable) console.warn(`[standalone-first-run] skipped: the OpenCode binary is not available: ${unavailable}`);

let model: FakeModelServer;
let build: SandboxedDir;
let binary: string;

beforeAll(() => {
  if (unavailable !== undefined) return;
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
  model?.stop();
  build?.cleanup();
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

describe.skipIf(unavailable !== undefined)("the standalone binary", () => {
  /** `akm agent --prompt` run on the standalone, offline, with the OpenCode binary linked into its cache. */
  async function agent(
    prompt: string,
  ): Promise<{ result: { ok: boolean; stdout: string; stderr: string }; npm: string }> {
    writeSandboxConfig({
      semanticSearchMode: "off",
      connections: { default: { endpoint: model.url, models: { fast: "fake-model", balanced: "fake-model" } } },
    });
    linkSharedOpencode(getCacheDir());
    const run = await runBinary(["agent", "--prompt", prompt], {
      ...process.env,
      npm_config_registry: UNREACHABLE_REGISTRY,
      NPM_CONFIG_REGISTRY: UNREACHABLE_REGISTRY,
      BUN_CONFIG_REGISTRY: UNREACHABLE_REGISTRY,
    });
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
    return {
      result: JSON.parse(run.stdout) as { ok: boolean; stdout: string; stderr: string },
      npm: path.join(getDataDir(), "opencode-runtime", "cache", "opencode", "npm"),
    };
  }

  test("runs on akm's own runtime offline, with nothing fetched and nothing downloaded for the provider", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const { result, npm } = await agent("MODE:answer ping");

      expect(result.ok).toBe(true);
      expect(result.stdout.trim()).toMatch(/^ANSWER-\d+$/);
      expect(model.requests.at(-1)?.mode).toBe("answer");
      // OpenCode installed nothing: no package was asked for, so its package cache was not even made.
      expect(fs.existsSync(npm) ? fs.readdirSync(npm) : []).toEqual([]);
    } finally {
      storage.cleanup();
    }
  }, 120_000);

  test("gives the agent akm's tools, and a call of one goes back into the standalone itself", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const { result } = await agent("MODE:akm look it up");

      expect(result.ok).toBe(true);
      expect(model.requests[0]?.tools).toEqual(expect.arrayContaining(["akm_search", "akm_show", "akm_curate"]));
      // What akm's search printed, as JSON, came back as the tool's result.
      expect(result.stdout).toMatch(/^AKM:\{[\s\S]*"hits"/);
    } finally {
      storage.cleanup();
    }
  }, 120_000);
});
