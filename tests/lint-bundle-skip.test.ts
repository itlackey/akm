// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import type { AkmConfig } from "../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

describe("bundle lint.skip", () => {
  let storage: IsolatedAkmStorage;
  const warnings: string[] = [];

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.join(" "));
    });
  });
  afterEach(() => {
    _setWarnSinkForTests(undefined);
    warnings.length = 0;
    storage.cleanup();
  });

  function seed(relative: string): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      "---\ndescription: Note\nupdated: 2026-11-01\n---\n\nSee [REDACTED] and /tmp/akm-5-gone/current.md\n",
    );
  }

  function configWithSkip(skip: Record<string, string[]>): AkmConfig {
    const config = makeConfig(storage.stashDir);
    config.bundles = { stash: { ...config.bundles?.stash, lint: { skip } } } as AkmConfig["bundles"];
    return config;
  }

  async function flaggedFiles(config: AkmConfig, issue: string): Promise<string[]> {
    const result = await akmLint({ dir: storage.stashDir, config });
    return result.flagged
      .filter((finding) => finding.issue === issue)
      .map((finding) => finding.file)
      .sort();
  }

  test("skips a rule for the assets whose bundle-relative path matches a glob", async () => {
    seed("knowledge/docs/a.md");
    seed("knowledge/docs/b.md");
    seed("knowledge/other.md");
    expect(await flaggedFiles(makeConfig(storage.stashDir), "stale-path")).toHaveLength(3);
    expect(await flaggedFiles(configWithSkip({ "stale-path": ["knowledge/docs/**"] }), "stale-path")).toEqual([
      "knowledge/other.md",
    ]);
    expect(await flaggedFiles(configWithSkip({ "stale-path": ["knowledge/other.md"] }), "stale-path")).toEqual([
      "knowledge/docs/a.md",
      "knowledge/docs/b.md",
    ]);
  });

  test("`**` skips the rule for the whole bundle and other rules still run", async () => {
    seed("knowledge/a.md");
    const config = configWithSkip({ "stale-path": ["**"] });
    expect(await flaggedFiles(config, "stale-path")).toEqual([]);
    expect(await flaggedFiles(config, "redacted-content")).toEqual(["knowledge/a.md"]);
  });

  test("a frontmatter lint_skip key no longer suppresses anything", async () => {
    const file = path.join(storage.stashDir, "knowledge", "a.md");
    fs.writeFileSync(
      file,
      "---\ndescription: Note\nupdated: 2026-11-01\nlint_skip: [stale-path]\n---\n\n/tmp/akm-5-gone/current.md\n",
    );
    expect(await flaggedFiles(makeConfig(storage.stashDir), "stale-path")).toEqual(["knowledge/a.md"]);
  });

  test("an unknown rule name warns once and is ignored", async () => {
    seed("knowledge/a.md");
    const config = configWithSkip({ "no-such-rule": ["**"], "stale-path": ["**"] });
    await akmLint({ dir: storage.stashDir, config });
    await akmLint({ dir: storage.stashDir, config });
    expect(warnings.filter((line) => line.includes("no-such-rule"))).toHaveLength(1);
    expect(await flaggedFiles(config, "stale-path")).toEqual([]);
  });
});
