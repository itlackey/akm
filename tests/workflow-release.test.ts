// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const source = fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const VERSION_INPUT = "$" + "{{ inputs.version }}";

describe("release workflow", () => {
  test("runs the gated suites, then one straightforward release job", () => {
    const workflow = YAML.parse(source) as { jobs: Record<string, { uses?: string; needs?: string }> };
    expect(Object.keys(workflow.jobs)).toEqual(["gated", "release"]);
    expect(workflow.jobs.gated?.uses).toBe("./.github/workflows/gated-ci.yml");
    expect(workflow.jobs.release?.needs).toBe("gated");
    expect(source).toContain("Require green CI on this commit");
    expect(source).toContain("bun install --frozen-lockfile");
    expect(source).toContain("bun run build");
    expect(source).toContain("npm publish");
    expect(source).toContain("gh release create");
  });

  test("publishes the exact version already committed in package.json", () => {
    expect(source).toContain(`CANDIDATE_VERSION: ${VERSION_INPUT}`);
    expect(source).toContain("require('./package.json').version");
    expect(source).toContain('"$PACKAGE_VERSION" != "$CANDIDATE_VERSION"');
    expect(source).not.toContain("npm version");
  });

  test("the changelog is cut: its newest released section names the shipping version", () => {
    // The release-cut step nothing else enforces. `release.yml` verifies
    // package.json against the workflow input, and the test above pins that —
    // but nothing checks the CHANGELOG was cut alongside it, and the failure is
    // silent and shipped: `resolveLatestVersion()`
    // (src/commands/sources/migration-help.ts) resolves release notes by
    // SKIPPING the `## [Unreleased]` heading, so a released binary whose
    // changelog still says `Unreleased` answers `akm help migrate latest` with
    // the PREVIOUS release's notes.
    //
    // Lives here rather than beside the renderer's own tests because this is a
    // property of the release, not of `renderMigrationHelp`. CI runs it on the
    // release commit, and release.yml refuses to publish until that CI passed.
    const root = path.resolve(import.meta.dir, "..");
    const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string })
      .version;
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    const newestReleased = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)]
      .map((match) => match[1])
      .find((heading) => heading?.toLowerCase() !== "unreleased");

    expect(
      newestReleased,
      `CHANGELOG.md's newest released section is [${newestReleased}] but package.json is ${version}. ` +
        `Rename "## [Unreleased]" to "## [${version}] - <YYYY-MM-DD>" and leave a fresh empty Unreleased above it.`,
    ).toBe(version);
  });

  test("builds all supported standalone binaries", () => {
    for (const artifact of [
      "akm-linux-x64",
      "akm-linux-arm64",
      "akm-darwin-x64",
      "akm-darwin-arm64",
      "akm-windows-x64.exe",
    ]) {
      expect(source).toContain(artifact);
    }
    expect(source).toContain("sha256sum akm-* install.sh install.ps1");
  });

  test("Bun Docker source builds include the changelog runtime asset", () => {
    const dockerDir = path.resolve(import.meta.dir, "docker");
    for (const distro of ["ubuntu", "debian", "alpine", "fedora"]) {
      const dockerfile = fs.readFileSync(path.join(dockerDir, `Dockerfile.${distro}-bun`), "utf8");
      expect(dockerfile).toContain("COPY CHANGELOG.md ./");
      expect(dockerfile.indexOf("COPY CHANGELOG.md ./")).toBeLessThan(dockerfile.indexOf("RUN bun run build"));
    }
  });

  test("keeps the dispatch value out of shell source", () => {
    const workflow = YAML.parse(source) as {
      jobs: { release: { steps: Array<{ run?: string }> } };
    };
    for (const step of workflow.jobs.release.steps) {
      expect(step.run ?? "").not.toContain(VERSION_INPUT);
    }
  });
});
