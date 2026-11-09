// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const source = fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const STAGE_INPUT = "$" + "{{ inputs.stage }}";

type Step = { name?: string; if?: string; run?: string };
type Job = {
  uses?: string;
  needs?: string | string[];
  if?: string;
  permissions?: unknown;
  steps?: Step[];
  strategy?: { matrix: { os: string[] } };
};
const workflow = YAML.parse(source) as {
  on: {
    push: { branches: string[] };
    workflow_dispatch: { inputs: Record<string, { type: string; default?: unknown; options?: string[] }> };
  };
  jobs: Record<string, Job>;
};
const resolve = workflow.jobs.release?.steps?.find((step) => step.name === "Resolve version");

describe("release workflow", () => {
  test("a stable release is the push that merges a release branch into main; a prerelease is a dispatch with a stage", () => {
    expect(Object.keys(workflow.on)).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    // No version input: the version is the one committed in package.json.
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["stage", "dry_run"]);
    expect(workflow.on.workflow_dispatch.inputs.stage).toMatchObject({
      type: "choice",
      default: "beta",
      options: ["alpha", "beta", "rc"],
    });
  });

  test("runs CI and Gated CI as its own jobs for a prerelease, then one release job, then Desktop and akm-web", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["ci", "gated", "release", "desktop", "akm-web"]);
    expect(workflow.jobs.ci?.uses).toBe("./.github/workflows/ci.yml");
    expect(workflow.jobs.gated?.uses).toBe("./.github/workflows/gated-ci.yml");
    expect(workflow.jobs.release?.needs).toEqual(["ci", "gated"]);
    expect(workflow.jobs.desktop?.needs).toBe("release");
    expect(workflow.jobs["akm-web"]?.needs).toBe("release");
    // The merge that makes a stable passed the gates on its pull request: only a dispatch runs them here.
    for (const gate of ["ci", "gated"]) {
      expect(workflow.jobs[gate]?.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(workflow.jobs[gate]?.if).toContain("!inputs.dry_run");
    }
    // A skipped gate (a stable, a dry run) lets the release go on; a failed or cancelled one stops it.
    expect(workflow.jobs.release?.if).toContain("!contains(needs.*.result, 'failure')");
    expect(workflow.jobs.release?.if).toContain("!contains(needs.*.result, 'cancelled')");
    // Nothing polls another workflow's run.
    expect(source).not.toContain("gh run list");
    expect(source).toContain("bun install --frozen-lockfile");
    expect(source).toContain("bun run build");
    expect(source).toContain("npm publish");
    expect(source).toContain("gh release create");
  });

  test("a stable publishes the version committed in package.json; a prerelease the release branch's version", () => {
    expect(resolve?.run).toContain(`VERSION_INPUT="$(node -p "require('./package.json').version")"`);
    expect(resolve?.run).toContain(`release/*) VERSION_INPUT="$` + `{GITHUB_REF_NAME#release/}" ;;`);
    // A dispatch anywhere but a release branch publishes nothing.
    expect(resolve?.run).toContain("A prerelease is dispatched on a release branch");
    expect(source).not.toContain("inputs.version");
    expect(source).not.toContain("npm version");
  });

  test("validates the version format and appends the stage through scripts/release-version.ts (#1089)", () => {
    // A push carries no inputs, so a stable release resolves with an empty stage.
    expect(source).toContain(`STAGE_INPUT: ${STAGE_INPUT}`);
    expect(source).toContain("bun scripts/release-version.ts resolve");
    // Only a stage changes the version the artifacts carry; it is stamped into this run's package.json.
    expect(source).toContain('npm pkg set version="$CANDIDATE_VERSION"');
    expect(source).toContain('echo "CANDIDATE_VERSION=$CANDIDATE_VERSION" >> "$GITHUB_ENV"');
    // Prereleases go to the `next` tag, stable builds to `latest`.
    expect(source).toContain('[[ "$CANDIDATE_VERSION" == *-* ]]');
    expect(source).toContain("DIST_TAG=next");
    expect(source).toContain("DIST_TAG=latest");
  });

  test("the changelog is cut: its newest released section names the shipping version", () => {
    // The release-cut step nothing else enforces. `release.yml` publishes the
    // committed package.json version, and the test above pins that — but
    // nothing checks the CHANGELOG was cut alongside it. CI runs it on the
    // release commit: on the release pull request for a stable, and as the
    // Release workflow's own `ci` job for a prerelease.
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

  test("a dry run builds everything and publishes nothing", () => {
    expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: "boolean", default: false });
    expect(workflow.jobs.desktop?.permissions).toEqual({ contents: "write" });
    const skipped = (job: string) =>
      workflow.jobs[job]?.steps?.filter((step) => step.if?.includes("!inputs.dry_run")).map((step) => step.name);
    // Everything that reads a secret or tags is skipped; the builds are not.
    expect(skipped("release")).toEqual(["Publish to npm", "Create GitHub release"]);
    expect(skipped("desktop")).toEqual(["Attach Desktop to the GitHub release"]);
    expect(skipped("akm-web")).toEqual(["Publish akm-web to npm"]);
    expect(workflow.jobs["akm-web"]?.permissions).toEqual({ contents: "read", "id-token": "write" });
    // The gates are skipped, and a skipped job upstream would skip Desktop unless it says it runs after a good release.
    expect(workflow.jobs.desktop?.if).toContain("needs.release.result == 'success'");
  });

  test("Desktop is built per platform from the tarball being published and attached to the same release", () => {
    expect(workflow.jobs.desktop?.strategy?.matrix.os).toEqual(["ubuntu-latest", "macos-latest", "windows-latest"]);
    expect(source).toContain('node scripts/core.mjs --tarball "$RUNNER_TEMP/engine/akm-cli-$VERSION.tgz"');
    expect(source).toContain("node scripts/package.mjs --release");
    expect(source).toContain("node scripts/smoke.mjs");
    expect(source).toContain('gh release upload "v$VERSION" desktop/dist/* --clobber');
  });

  test("akm-web is published from the same tarball, independent of the Desktop installers", () => {
    expect(source).toContain("node scripts/package-web.mjs --release");
    expect(source).toContain('npm publish "$STAGE" --ignore-scripts --provenance --access public --tag "$DIST_TAG"');
  });

  test("the installers attached to a release install that release", () => {
    expect(source).toContain('s|^TAG=\\"latest\\"$|TAG=\\"v$CANDIDATE_VERSION\\"|');
    expect(source).toContain('else { \\"v$CANDIDATE_VERSION\\" }');
    const scripts = ["install.sh", "install.ps1"].map((name) =>
      fs.readFileSync(path.resolve(import.meta.dir, "..", name), "utf8"),
    );
    // The lines the pinning rewrites must still exist in the repository's copies.
    expect(scripts[0]).toMatch(/^TAG="latest"$/m);
    expect(scripts[1]).toContain('else { "latest" }');
  });

  test("Bun Docker source builds include the changelog runtime asset", () => {
    const dockerDir = path.resolve(import.meta.dir, "docker");
    for (const distro of ["ubuntu", "debian", "alpine", "fedora"]) {
      const dockerfile = fs.readFileSync(path.join(dockerDir, `Dockerfile.${distro}-bun`), "utf8");
      expect(dockerfile).toContain("COPY CHANGELOG.md ./");
      expect(dockerfile.indexOf("COPY CHANGELOG.md ./")).toBeLessThan(dockerfile.indexOf("RUN bun run build"));
    }
  });

  test("keeps the dispatch inputs out of shell source", () => {
    for (const step of workflow.jobs.release?.steps ?? []) {
      expect(step.run ?? "").not.toContain("$" + "{{ inputs.");
    }
  });
});
