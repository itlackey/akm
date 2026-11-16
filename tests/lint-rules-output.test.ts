// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import { type GitRunner, trackedSecretIssues } from "../src/commands/lint/tracked-secrets";
import type { AkmConfig } from "../src/core/config/config";
import { formatLintPlain } from "../src/output/text/lint-format";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

describe("akm lint: per-rule summary, --rule listing and rule precision", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  function write(relative: string, text: string): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const page = (body: string, frontmatter = "description: Note\nupdated: 2026-11-01"): string =>
    `---\n${frontmatter}\n---\n${body}`;

  function seedFindings(): void {
    write("memories/a.md", page("\nSee /tmp/akm-6-gone/a.\nAnd /tmp/akm-6-gone/b.\n"));
    write("memories/b.md", page("\nSee /tmp/akm-6-gone/c.\n"));
    write("knowledge/c.md", page("\nSee /tmp/akm-6-gone/d.\n", "description: Note"));
  }

  test("counts flagged findings and assets per rule", async () => {
    seedFindings();
    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.byRule).toEqual({
      "stale-path": { findings: 4, assets: 3 },
      "missing-updated": { findings: 1, assets: 1 },
    });
  });

  test("the default text output is one line per rule with folders, the --fix answer and the way to fix it", async () => {
    seedFindings();
    const text = formatLintPlain({
      ...(await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) })),
    });
    const lines = (text ?? "").split("\n");
    const stalePath = lines.find((line) => line.trim().startsWith("stale-path:"));
    expect(stalePath).toContain("4 findings in 3 assets");
    expect(stalePath).toContain("memories (3), knowledge (1)");
    expect(stalePath).toContain("--fix does not fix it");
    expect(stalePath).toContain("History/Examples heading");
    expect(lines.find((line) => line.trim().startsWith("missing-updated:"))).toContain("--fix fixes it");
    expect(text).not.toContain("/tmp/akm-6-gone/a");
  });

  test("--rule lists that rule's findings by asset, narrowed by --type", async () => {
    seedFindings();
    const result = await akmLint({
      dir: storage.stashDir,
      config: makeConfig(storage.stashDir),
      rule: "stale-path",
      typeFilter: "memories",
    });
    expect(result.rule).toBe("stale-path");
    expect(result.flagged.map((finding) => finding.issue)).toEqual(["stale-path", "stale-path", "stale-path"]);
    const text = formatLintPlain({ ...result }) ?? "";
    expect(text).toContain("stale-path: 3 findings in 2 assets");
    expect(text).toContain("memories/a  (memories/a.md)");
    expect(text).toContain("line 6  /tmp/akm-6-gone/a  ephemeral; nearest existing: /tmp");
    expect(text).toContain("      See /tmp/akm-6-gone/a.");
    expect(text).not.toContain("knowledge/c");
  });

  test("--rule cannot combine with --fix, and an unknown rule shows every rule", async () => {
    seedFindings();
    const config = makeConfig(storage.stashDir);
    await expect(akmLint({ dir: storage.stashDir, config, rule: "stale-path", fix: true })).rejects.toThrow(
      "--rule lists findings",
    );
    const result = await akmLint({ dir: storage.stashDir, config, rule: "no-such-rule" });
    expect(result.rule).toBeUndefined();
    expect(Object.keys(result.byRule)).toEqual(["stale-path", "missing-updated"]);
  });

  test("missing-updated does not apply to skills", async () => {
    write("skills/imported/SKILL.md", "---\nname: imported\ndescription: Imported skill\n---\n\nBody.\n");
    write("knowledge/c.md", page("\nBody.\n", "description: Note"));
    const result = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(result.flagged.filter((f) => f.issue === "missing-updated").map((f) => f.file)).toEqual(["knowledge/c.md"]);
  });

  test("any rule lint reports can be skipped, tracked-secrets and missing-skill-md included", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "skills", "empty"), { recursive: true });
    const config = makeConfig(storage.stashDir);
    expect((await akmLint({ dir: storage.stashDir, config })).byRule["missing-skill-md"]).toBeDefined();
    config.bundles = {
      stash: { ...config.bundles?.stash, lint: { skip: { "missing-skill-md": ["skills/**"] } } },
    } as AkmConfig["bundles"];
    expect((await akmLint({ dir: storage.stashDir, config })).byRule["missing-skill-md"]).toBeUndefined();
  });
});

describe("tracked-secrets", () => {
  function fakeGit(opts: { isRepo?: boolean; tracked?: string[]; remotes?: string[] }): GitRunner {
    return (_root, args) => {
      if (args[0] === "rev-parse") return { ok: opts.isRepo !== false, stdout: "true" };
      if (args[0] === "ls-files") return { ok: true, stdout: (opts.tracked ?? []).join("\n") };
      if (args[0] === "remote") return { ok: true, stdout: (opts.remotes ?? []).join("\n") };
      return { ok: false, stdout: "" };
    };
  }

  test("one finding per tracked env or secrets file when the repository has a remote", () => {
    const issues = trackedSecretIssues(
      "/bundle",
      fakeGit({ tracked: ["env/prod.env", "secrets/signing.key"], remotes: ["origin"] }),
    );
    expect(issues.map((issue) => [issue.file, issue.issue])).toEqual([
      ["env/prod.env", "tracked-secrets"],
      ["secrets/signing.key", "tracked-secrets"],
    ]);
  });

  test.each([
    ["tracked but no remote", { tracked: ["env/prod.env"], remotes: [] }],
    ["a remote but nothing tracked", { tracked: [], remotes: ["origin"] }],
    ["not a git repository", { isRepo: false, remotes: ["origin"] }],
  ])("nothing for %s", (_label, opts) => {
    expect(trackedSecretIssues("/bundle", fakeGit(opts))).toEqual([]);
  });

  describe("in a real repository", () => {
    let storage: IsolatedAkmStorage;
    beforeEach(() => {
      storage = withIsolatedAkmStorage();
      const git = (...args: string[]): void => {
        spawnSync("git", ["-C", storage.stashDir, ...args], { encoding: "utf8" });
      };
      git("init", "-q");
      git("remote", "add", "origin", "https://example.invalid/stash.git");
      fs.mkdirSync(path.join(storage.stashDir, "env"), { recursive: true });
      fs.writeFileSync(path.join(storage.stashDir, "env", "prod.env"), "TOKEN=x\n");
      git("add", "-f", "env/prod.env");
    });
    afterEach(() => storage.cleanup());

    test("lint flags the tracked file and `lint.skip` silences it", async () => {
      const config = makeConfig(storage.stashDir);
      const flagged = (await akmLint({ dir: storage.stashDir, config })).flagged.filter(
        (finding) => finding.issue === "tracked-secrets",
      );
      expect(flagged.map((finding) => [finding.file, finding.ref])).toEqual([["env/prod.env", "env/prod"]]);

      config.bundles = {
        stash: { ...config.bundles?.stash, lint: { skip: { "tracked-secrets": ["**"] } } },
      } as AkmConfig["bundles"];
      const skipped = await akmLint({ dir: storage.stashDir, config });
      expect(skipped.flagged.filter((finding) => finding.issue === "tracked-secrets")).toEqual([]);
    });
  });
});
