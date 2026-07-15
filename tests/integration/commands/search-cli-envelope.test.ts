// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm search` / `akm curate` / `akm show`
 * command family. Pins the full JSON envelope (stdout payload shape + the
 * {ok:false,code} error envelope on stderr / exit code) for representative
 * invocations, proving the extraction of the cluster from cli.ts into
 * src/commands/search-cli.ts and the migration of the leaf handlers onto
 * `defineJsonCommand` is byte-identical. The three commands share the private
 * `resolveEventSource` helper and the `parseScopeFilterFlags`/`parseSearchSource`
 * parsers, which moved with the cluster. The CLI reads an isolated, freshly
 * indexed stash through AKM_STASH_DIR via the in-process harness.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { runCliCapture } from "../../_helpers/cli";
import {
  type Cleanup,
  makeStashDir,
  type SandboxedDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_STASH_DIR: stashDir }, async () => {
    resetConfigCache();
    const res = await runCliCapture(args);
    return { stdout: res.stdout, stderr: res.stderr, status: res.code };
  });
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  envCleanup = dataResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  for (const d of disposers.splice(0)) d.cleanup();
});

async function makeIndexedStash(): Promise<string> {
  const sandbox = makeStashDir();
  disposers.push(sandbox);
  const stash = sandbox.dir;
  fs.mkdirSync(path.join(stash, "skills", "deploy-widgets"), { recursive: true });
  fs.writeFileSync(
    path.join(stash, "skills", "deploy-widgets", "SKILL.md"),
    "---\ndescription: deploy widgets uniformly\ntags:\n  - deploy\nquality: curated\n---\n# Deploy widgets\n",
  );
  await withEnv({ AKM_STASH_DIR: stash }, async () => {
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir: stash, full: true });
  });
  return stash;
}

describe("akm search/curate/show — JSON envelope snapshot (WS6)", () => {
  test("search: indexed stash → success envelope with hits array", async () => {
    const stash = await makeIndexedStash();
    const { stdout, status } = await runCli(["--json", "search", "deploy"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.hits)).toBe(true);
    expect((env.hits as Array<{ name: string }>).map((h) => h.name)).toContain("deploy-widgets");
  });

  test("search --no-project-context does not mutate process env", async () => {
    const stash = await makeIndexedStash();
    delete process.env.AKM_DISABLE_PROJECT_CONTEXT;
    delete process.env.AKM_DISABLE_SCOPED_UTILITY;

    const { status } = await runCli(["--json", "search", "deploy", "--no-project-context"], stash);

    expect(status).toBe(0);
    expect(process.env.AKM_DISABLE_PROJECT_CONTEXT).toBeUndefined();
    expect(process.env.AKM_DISABLE_SCOPED_UTILITY).toBeUndefined();
  });

  test("search: missing query → byte-identical {ok:false} usage envelope on stderr", async () => {
    const stash = await makeIndexedStash();
    const { stderr, status } = await runCli(["--json", "search"], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("curate: indexed stash → success envelope with shape 'curate'", async () => {
    const stash = await makeIndexedStash();
    const { stdout, status } = await runCli(["--json", "curate", "deploy widgets"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("curate");
  });

  test("curate: missing query → byte-identical {ok:false} usage envelope on stderr", async () => {
    const stash = await makeIndexedStash();
    const { stderr, status } = await runCli(["--json", "curate"], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("show: known ref → success envelope with the asset payload", async () => {
    const stash = await makeIndexedStash();
    const { stdout, status } = await runCli(["--json", "show", "skill:deploy-widgets"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.type).toBe("skill");
    expect(env.name).toBe("deploy-widgets");
    expect(typeof env.content).toBe("string");
  });

  test("show: unknown ref → byte-identical {ok:false} not-found envelope on stderr", async () => {
    const stash = await makeIndexedStash();
    const { stderr, status } = await runCli(["--json", "show", "skill:does-not-exist"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("ASSET_NOT_FOUND");
  });
});
