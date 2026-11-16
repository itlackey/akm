// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `bundlePolicy` step: `lint_skip` frontmatter is stripped, the old `.gitignore` track-secrets marker adds a
 * `tracked-secrets` lint skip to the bundle's config entry, and `.gitignore` is never modified. Runs through
 * `runMigration` against an isolated bundle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const MARKER = "# akm: intentionally track env and secrets";

describe("the step", () => {
  let storage: IsolatedAkmStorage;
  const stash = (): string => storage.stashDir;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetConfigCache();
  });
  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  function write(relative: string, text: string): string {
    const file = path.join(stash(), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }
  const read = (relative: string): string => fs.readFileSync(path.join(stash(), relative), "utf8");
  const page = (skip: string): string => `---\nname: x\n${skip}tags:\n  - a\n---\nBody.\n`;

  function configure(entry: Record<string, unknown> = {}): void {
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: { primary: { path: stash(), writable: true, ...entry } },
    });
  }
  const bundleEntry = (): Record<string, unknown> => {
    const config = JSON.parse(fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8"));
    return config.bundles.primary;
  };

  function seed(): void {
    write("knowledge/docs/a.md", page("lint_skip:\n  - stale-path\n"));
    write("knowledge/docs/b.md", page("lint_skip: [stale-path]\n"));
    write("knowledge/other/c.md", page("lint_skip: stale-path\n"));
    write("knowledge/keep.md", page(""));
    write(".gitignore", `# mine\n*.log\n${MARKER}\n!env/\n`);
  }

  test("strips lint_skip, moves nothing into lint.skip but the tracked-secrets skip, and leaves .gitignore alone", async () => {
    configure();
    seed();
    const gitignore = read(".gitignore");
    const dry = await runMigration({ apply: false });
    expect(dry.bundlePolicy?.changed).toBe(4);
    expect(read("knowledge/docs/a.md")).toContain("lint_skip");

    const applied = await runMigration({ apply: true });
    expect(applied.bundlePolicy?.bundles).toEqual([{ bundleId: "primary", stripped: 3, skipTrackedSecrets: true }]);
    expect(applied.bundlePolicy?.backupPath).toBeDefined();
    expect(bundleEntry().lint).toEqual({ skip: { "tracked-secrets": ["**"] } });
    for (const file of ["docs/a", "docs/b", "other/c"]) expect(read(`knowledge/${file}.md`)).toBe(page(""));
    expect(read(".gitignore")).toBe(gitignore);
    const backup = path.join(applied.bundlePolicy?.backupPath as string, "files");
    expect(fs.readdirSync(backup).map((name) => fs.readFileSync(path.join(backup, name), "utf8"))).toContain(
      page("lint_skip:\n  - stale-path\n"),
    );
  });

  test("without the marker the config gains nothing", async () => {
    configure();
    write("knowledge/one.md", page("lint_skip: [stale-path]\n"));
    const applied = await runMigration({ apply: true });
    expect(applied.bundlePolicy?.bundles).toEqual([{ bundleId: "primary", stripped: 1, skipTrackedSecrets: false }]);
    expect(bundleEntry().lint).toBeUndefined();
  });

  test("is idempotent", async () => {
    configure();
    seed();
    await runMigration({ apply: true });
    const before = bundleEntry();
    const again = await runMigration({ apply: true });
    expect(again.bundlePolicy?.changed).toBe(0);
    expect(again.bundlePolicy?.applied).toBeUndefined();
    expect(bundleEntry()).toEqual(before);
  });

  test("keeps the skips the config already has", async () => {
    configure({ lint: { skip: { "stale-path": ["wikis/**"] } } });
    write(".gitignore", `${MARKER}\n`);
    await runMigration({ apply: true });
    expect(bundleEntry().lint).toEqual({ skip: { "stale-path": ["wikis/**"], "tracked-secrets": ["**"] } });
  });

  test("a bundle with no config entry has lint_skip stripped; its marker is reported, not moved", async () => {
    writeSandboxConfig({
      defaultBundle: "other",
      bundles: { other: { path: path.join(stash(), "elsewhere"), writable: true } },
    });
    seed();
    const plan = await runMigration({ apply: true });
    expect(plan.bundlePolicy?.changed).toBe(3);
    expect(plan.bundlePolicy?.notes).toHaveLength(1);
    expect(read("knowledge/docs/a.md")).toBe(page(""));
    expect(read(".gitignore")).toContain(MARKER);
  });
});
