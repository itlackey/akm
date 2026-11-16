// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `bundlePolicy` step: `lint_skip` frontmatter and the `.gitignore` track-secrets marker move into the bundle's
 * config entry, and akm's own `.gitignore` blocks are removed. Runs through `runMigration` against an isolated bundle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const SECRETS_BLOCK =
  "# akm: keep secret material out of git by default\n" +
  "# env/ and secrets/ assets hold tokens and keys. They are ignored by default\n" +
  "# so `git push` can never leak them. To version a specific one (e.g. for a\n" +
  "# private-remote backup), un-ignore its path below once you accept the risk.\n" +
  "env/\nsecrets/\n\n";

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
    write("knowledge/docs/c.md", page("lint_skip: stale-path\n"));
    write("knowledge/other/d.md", page("lint_skip:\n  - stale-path\n  - missing-ref\n  - made-up\n"));
    write("knowledge/other/e.md", page(""));
    write("knowledge/keep.md", page(""));
    write(".gitignore", `# mine\n*.log\n${SECRETS_BLOCK}# akm: intentionally track env and secrets\n!env/\n`);
  }

  test("moves lint_skip into lint.skip as directory globs or exact paths and strips the key", async () => {
    configure();
    seed();
    const dry = await runMigration({ apply: false });
    expect(dry.bundlePolicy?.changed).toBe(5);
    expect(read("knowledge/docs/a.md")).toContain("lint_skip");

    const applied = await runMigration({ apply: true });
    expect(applied.bundlePolicy?.applied).toBe(5);
    expect(applied.bundlePolicy?.backupPath).toBeDefined();
    expect(bundleEntry().lint).toEqual({
      skip: { "stale-path": ["knowledge/docs/**", "knowledge/other/d.md"], "missing-ref": ["knowledge/other/d.md"] },
    });
    expect(bundleEntry().trackSecrets).toBe(true);
    for (const file of ["a", "b", "c"]) expect(read(`knowledge/docs/${file}.md`)).toBe(page(""));
    expect(read("knowledge/other/d.md")).toBe(page(""));
    expect(read(".gitignore")).toBe("# mine\n*.log\n!env/\n");
    const backup = path.join(applied.bundlePolicy?.backupPath as string, "files");
    expect(fs.readdirSync(backup).map((name) => fs.readFileSync(path.join(backup, name), "utf8"))).toContain(
      page("lint_skip:\n  - stale-path\n"),
    );
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

  test("keeps the globs the config already has", async () => {
    configure({ lint: { skip: { "stale-path": ["wikis/**"] } } });
    write("knowledge/one.md", page("lint_skip: [stale-path]\n"));
    await runMigration({ apply: true });
    expect(bundleEntry().lint).toEqual({ skip: { "stale-path": ["wikis/**", "knowledge/one.md"] } });
  });

  test("a bundle with no config entry keeps its files as written", async () => {
    writeSandboxConfig({
      defaultBundle: "other",
      bundles: { other: { path: path.join(stash(), "elsewhere"), writable: true } },
    });
    seed();
    const plan = await runMigration({ apply: true });
    expect(plan.bundlePolicy?.changed).toBe(0);
    expect(plan.bundlePolicy?.notes).toHaveLength(1);
    expect(read("knowledge/docs/a.md")).toContain("lint_skip");
  });
});
