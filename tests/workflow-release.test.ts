// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const source = fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const VERSION_INPUT = "$" + "{{ inputs.version }}";
const STAGE_INPUT = "$" + "{{ inputs.stage }}";

describe("release workflow", () => {
  test("is one straightforward release job", () => {
    const workflow = YAML.parse(source) as { jobs: Record<string, unknown> };
    expect(Object.keys(workflow.jobs)).toEqual(["release"]);
    expect(source).toContain("bun install --frozen-lockfile");
    expect(source).toContain("bun run build");
    expect(source).toContain("npm publish");
    expect(source).toContain("gh release create");
  });

  test("publishes the exact version already committed in package.json", () => {
    expect(source).toContain(`VERSION_INPUT: ${VERSION_INPUT}`);
    expect(source).toContain("require('./package.json').version");
    expect(source).toContain('"$PACKAGE_VERSION" != "$VERSION_INPUT"');
    expect(source).not.toContain("npm version");
  });

  test("validates the version format and appends the stage through scripts/release-version.ts (#1089)", () => {
    expect(source).toContain(`STAGE_INPUT: ${STAGE_INPUT}`);
    expect(source).toContain("bun scripts/release-version.ts resolve");
    // Only a stage changes the version the artifacts carry; it is stamped into this run's package.json.
    expect(source).toContain('npm pkg set version="$CANDIDATE_VERSION"');
    expect(source).toContain('echo "CANDIDATE_VERSION=$CANDIDATE_VERSION" >> "$GITHUB_ENV"');
    // Prereleases go to the `next` tag, stable builds to `latest`.
    expect(source).toContain('[[ "$CANDIDATE_VERSION" == *-* ]]');
    expect(source).toContain("DIST_TAG=next");
    expect(source).toContain("DIST_TAG=latest");
    const workflow = YAML.parse(source) as {
      on: { workflow_dispatch: { inputs: { stage: { type: string; options: string[] } } } };
    };
    expect(workflow.on.workflow_dispatch.inputs.stage.options).toEqual(["none", "alpha", "beta", "rc"]);
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
    // property of the release, not of `renderMigrationHelp` — and this file is
    // `run_step "Workflow Release Contract"`, the first gate in
    // tests/release-check.sh, so it fails in seconds under the name a release
    // engineer is looking at.
    const root = path.resolve(import.meta.dir, "..");
    // A daily build's -alpha/-beta/-rc stage is stamped in at release time (#1089): its changelog section is the
    // build's, so the committed package.json carries no stage.
    const version = (
      JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }
    ).version.replace(/^(0\.\d+\.\d{8})-(alpha|beta|rc)$/, "$1");
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
