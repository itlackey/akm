// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A `bun test` run must close the embedded OpenCode hosts its tests opened.
 * The runner caches them for the life of the process and only closes them
 * on an explicit `closeOpencodeSdk()` — and `bun test` never emits `exit` when
 * a run ends normally (bun 1.4.1). Any test that dispatched through the real
 * runner therefore left its host open, holding the database and the run's HOME
 * open past the tests. The same missing `exit` left `/tmp/akm-test-suite-*`
 * behind: the preload removed it only from `process.on("exit")`, so every run
 * left one.
 *
 * `tests/_preload.ts` closes the runner's hosts, then removes the suite
 * sandbox, in a global `afterAll`. This runs a real `bun test` of a fixture that
 * completes a dispatch against a loopback model and never closes the host, then
 * proves the host was closed and the run's suite sandbox is gone.
 *
 * Integration-scoped (ORG-03/06): spawns a real `bun test`.
 */

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const EMBEDDED = path.join(REPO_ROOT, "src/integrations/harnesses/opencode/embedded");
const MODEL_SERVER = path.join(REPO_ROOT, "tests/_helpers/fake-model-server.ts");
const SANDBOX_HELPERS = path.join(REPO_ROOT, "tests/_helpers/sandbox.ts");

test("a bun test run closes the embedded OpenCode hosts its tests opened and removes its suite sandbox", async () => {
  const sandbox = makeSandboxDir("akm-sdk-teardown");
  const closedFile = path.join(sandbox.dir, "host.closed");
  const homeFile = path.join(sandbox.dir, "suite.home");
  const fixture = path.join(sandbox.dir, "open-host.test.ts");
  // Completes a dispatch through the real SDK and never closes the host, and records its HOME
  // (`<suite sandbox>/home`) for the assertion below. The factory marks the host's close.
  fs.writeFileSync(
    fixture,
    [
      `import { expect, test } from "bun:test";`,
      `import { writeFileSync } from "node:fs";`,
      `import { _setOpencodeHostFactoryForTests } from ${JSON.stringify(path.join(EMBEDDED, "host.ts"))};`,
      `import { runOpencodeSdk } from ${JSON.stringify(path.join(EMBEDDED, "run.ts"))};`,
      `import { createSdkHost } from ${JSON.stringify(path.join(EMBEDDED, "sdk-host.ts"))};`,
      `import { startFakeModel } from ${JSON.stringify(MODEL_SERVER)};`,
      `import { writeSandboxConfig } from ${JSON.stringify(SANDBOX_HELPERS)};`,
      `test("completes a dispatch and leaves the host cached", async () => {`,
      `  writeFileSync(${JSON.stringify(homeFile)}, process.env.HOME as string);`,
      `  const model = startFakeModel();`,
      `  writeSandboxConfig({ connections: { teardown: { endpoint: model.url, models: { fast: "fake-model" } } } });`,
      `  _setOpencodeHostFactoryForTests(async (spec) => {`,
      `    const host = await createSdkHost(spec);`,
      `    const close = host.close.bind(host);`,
      `    host.close = async () => { writeFileSync(${JSON.stringify(closedFile)}, "closed"); await close(); };`,
      `    return host;`,
      `  });`,
      `  const profile = { name: "teardown", bin: "", args: [], platform: "opencode-sdk", envPassthrough: [] };`,
      `  const result = await runOpencodeSdk(profile as never, { timeoutMs: 30_000, dispatch: { prompt: "MODE:answer ping" } }, { endpoint: model.url, model: "fake-model" });`,
      `  model.stop();`,
      `  expect(result.ok).toBe(true);`,
      `});`,
    ].join("\n"),
  );

  try {
    // cwd = repo root so the child run loads bunfig.toml and its preload, exactly as the suite does.
    const run = Bun.spawnSync([process.execPath, "test", fixture], { cwd: REPO_ROOT, timeout: 60_000 });
    if (run.exitCode !== 0) {
      throw new Error(`fixture run exited ${run.exitCode}\n${run.stdout.toString()}\n${run.stderr.toString()}`);
    }
    expect(fs.existsSync(closedFile)).toBe(true);
    // The run is over, so the suite sandbox its preload created (HOME's parent) must be gone.
    const suiteRoot = path.dirname(fs.readFileSync(homeFile, "utf8"));
    expect(path.basename(suiteRoot)).toStartWith("akm-test-suite-");
    expect(fs.existsSync(suiteRoot)).toBe(false);
  } finally {
    sandbox.cleanup();
  }
}, 90_000);
