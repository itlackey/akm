/**
 * A task's `uses:` asset in another bundle resolves through the one ref-to-file
 * walk. Reading it needs no write target, so a bundle that cannot be written
 * (an npm install, a read-only filesystem bundle) resolves like any other.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../src/core/config/config";
import { NotFoundError, UsageError } from "../../src/core/errors";
import { writeLockfile } from "../../src/integrations/lockfile";
import { resolveBundleAsset } from "../../src/tasks/run/load-task";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const sandboxes: SandboxedDir[] = [];

afterEach(async () => {
  await writeLockfile([]);
  for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
});

function bundleRoot(prefix: string, files: Record<string, string>): string {
  const root = makeSandboxDir(prefix);
  sandboxes.push(root);
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root.dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root.dir;
}

describe("resolveBundleAsset", () => {
  test("resolves a script in a read-only filesystem bundle", () => {
    const work = bundleRoot("akm-task-work", { "scripts/local.sh": "echo local\n" });
    const shared = bundleRoot("akm-task-shared", { "scripts/deploy.sh": "echo deploy\n" });
    const config = {
      defaultBundle: "work",
      bundles: { work: { path: work }, shared: { path: shared, writable: false } },
    } as unknown as AkmConfig;

    const resolved = resolveBundleAsset(config, { bundle: "shared", type: "script", name: "deploy.sh" });

    expect(resolved).toEqual({ file: fs.realpathSync(path.join(shared, "scripts", "deploy.sh")), bundleRoot: shared });
  });

  test("resolves a script in an npm bundle at its lock's content root", async () => {
    const work = bundleRoot("akm-task-work", { "scripts/local.sh": "echo local\n" });
    const installed = bundleRoot("akm-task-npm", { "scripts/build.sh": "echo build\n" });
    await writeLockfile([
      { id: "tools", source: "npm", ref: "npm:tools", localRoot: installed, installedAt: "2026-07-20T00:00:00.000Z" },
    ]);
    const config = {
      defaultBundle: "work",
      bundles: { work: { path: work }, tools: { npm: "tools" } },
    } as unknown as AkmConfig;

    const resolved = resolveBundleAsset(config, { bundle: "tools", type: "script", name: "build.sh" });

    expect(resolved).toEqual({
      file: fs.realpathSync(path.join(installed, "scripts", "build.sh")),
      bundleRoot: installed,
    });
  });

  test("an unknown bundle and a missing asset fail differently", () => {
    const work = bundleRoot("akm-task-work", { "scripts/local.sh": "echo local\n" });
    const config = { defaultBundle: "work", bundles: { work: { path: work } } } as unknown as AkmConfig;

    expect(() => resolveBundleAsset(config, { bundle: "ghost", type: "script", name: "x.sh" })).toThrow(UsageError);
    expect(() => resolveBundleAsset(config, { bundle: "work", type: "script", name: "missing.sh" })).toThrow(
      NotFoundError,
    );
  });
});
