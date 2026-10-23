// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Installing a bundle is the trust decision (#1237): `bundle add` and
 * `bundle update` never inspect a bundle's `env/` files for process-hijacking
 * keys, so a bundle whose `env/*.env` sets `PATH` installs and refreshes
 * non-interactively with no flag.
 *
 * Integration: opens the real index database (`akmAdd` / `akmUpdate` index).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as syncFromRefModule from "../../src/sources/providers/sync-from-ref";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, makeSandboxDir, withIsolatedAkmStorage, withTTY } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const disposers: Array<() => void> = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  storage.cleanup();
});

function bundleWithPathEnv(prefix: string): string {
  const created = makeSandboxDir(prefix);
  disposers.push(created.cleanup);
  fs.mkdirSync(path.join(created.dir, "env"), { recursive: true });
  fs.writeFileSync(path.join(created.dir, "env", "x.env"), "PATH=/opt/team/bin\nLD_PRELOAD=/opt/team/lib.so\n");
  fs.mkdirSync(path.join(created.dir, "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(created.dir, "knowledge", "note.md"),
    "---\ntype: knowledge\ndescription: Team note\n---\n\n# Team note\n",
  );
  return created.dir;
}

describe("bundle add and update carry no env-key gate (#1237)", () => {
  test("bundle add of a local bundle whose env/x.env sets PATH succeeds non-interactively with no flag", async () => {
    const root = bundleWithPathEnv("akm-1237-local");
    const result = await withTTY(false, () => runCliCapture(["bundle", "add", root]));
    expect(result.stderr).not.toContain("DANGEROUS_ENV");
    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(root, "env", "x.env"))).toBe(true);
  }, 30_000);

  test("bundle add and bundle update --all of a registry bundle with PATH in env/ succeed with no flag", async () => {
    const root = bundleWithPathEnv("akm-1237-registry");
    const ref = "npm:team-bundle";
    const spy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: ref,
      source: "npm",
      ref,
      artifactUrl: "https://registry.npmjs.org/team-bundle/-/team-bundle-1.0.0.tgz",
      contentDir: root,
      cacheDir: root,
      extractedDir: root,
      resolvedVersion: "1.0.0",
      integrity: "sha512-team-fixture",
      syncedAt: "2026-10-22T00:00:00.000Z",
      writable: false,
    });
    try {
      const added = await withTTY(false, () => runCliCapture(["bundle", "add", ref]));
      expect(added.stderr).not.toContain("DANGEROUS_ENV");
      expect(added.code).toBe(0);
      const updated = await withTTY(false, () => runCliCapture(["bundle", "update", "--all", "--force"]));
      expect(updated.stderr).not.toContain("DANGEROUS_ENV");
      expect(updated.stdout).not.toContain("blocked");
      expect(updated.code).toBe(0);
      expect(fs.existsSync(root)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test("--allow-dangerous-env-keys is still accepted as a deprecated no-op", async () => {
    const root = bundleWithPathEnv("akm-1237-noop");
    const result = await withTTY(false, () => runCliCapture(["bundle", "add", root, "--allow-dangerous-env-keys"]));
    expect(result.code).toBe(0);
  }, 30_000);
});
