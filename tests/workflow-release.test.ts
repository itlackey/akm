// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const source = fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const VERSION_INPUT = "$" + "{{ inputs.version }}";
const STAGE_INPUT = "$" + "{{ inputs.stage }}";

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
    // property of the release, not of `renderMigrationHelp`. CI runs it on the
    // release commit, and release.yml refuses to publish until that CI passed.
    const root = path.resolve(import.meta.dir, "..");
    // A release's -alpha/-beta/-rc stage is stamped in at release time (#1089): its changelog section is the
    // release's, so the committed package.json carries no stage.
    const version = (
      JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }
    ).version.replace(/^(0\.\d+\.\d{6})-(alpha|beta|rc)$/, "$1");
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

  describe("the CI gate waits for the CI run on the commit", () => {
    const workflow = YAML.parse(source) as {
      jobs: { release: { steps: Array<{ name?: string; run?: string }> } };
    };
    const steps = workflow.jobs.release.steps;
    const gate = steps.find((step) => step.name === "Require green CI on this commit");

    // Runs the step's script with a fake `gh` that records its arguments and prints one snapshot of `gh run list`
    // per call (the last one repeats), and a fake `sleep` that counts its calls and returns at once. A snapshot
    // line is the step's jq projection of one run, newest first: "<event> <status> <conclusion>".
    function runGate(snapshots: string[]): { status: number | null; stderr: string; sleeps: number; args: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-release-gate-"));
      try {
        snapshots.forEach((snapshot, index) => {
          fs.writeFileSync(path.join(dir, `snapshot-${index + 1}`), snapshot);
        });
        fs.writeFileSync(
          path.join(dir, "gh"),
          [
            "#!/bin/sh",
            `echo "$*" > "${dir}/args"`,
            `n=$(( $(cat "${dir}/calls" 2>/dev/null || echo 0) + 1 ))`,
            `echo "$n" > "${dir}/calls"`,
            `[ "$n" -le ${snapshots.length} ] || n=${snapshots.length}`,
            `cat "${dir}/snapshot-$n"`,
          ].join("\n"),
          { mode: 0o755 },
        );
        fs.writeFileSync(path.join(dir, "sleep"), `#!/bin/sh\necho x >> "${dir}/sleeps"\n`, { mode: 0o755 });
        const result = spawnSync("bash", ["-e", "-c", gate?.run ?? ""], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc123" },
        });
        const sleepsFile = path.join(dir, "sleeps");
        const sleeps = fs.existsSync(sleepsFile) ? fs.readFileSync(sleepsFile, "utf8").trim().split("\n").length : 0;
        const args = fs.readFileSync(path.join(dir, "args"), "utf8");
        return { status: result.status, stderr: result.stderr, sleeps, args };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    test("sits after the build and before the publish, and nothing before it publishes", () => {
      const names = steps.map((step) => step.name);
      const at = names.indexOf("Require green CI on this commit");
      expect(at).toBeGreaterThan(names.indexOf("Build package and binaries"));
      expect(at).toBeLessThan(names.indexOf("Publish to npm"));
      for (const step of steps.slice(0, at)) {
        expect(step.run ?? "").not.toMatch(/npm publish|gh release|git tag|git push/);
      }
    });

    test("asks for the CI workflow's runs on this commit", () => {
      expect(runGate(["push completed success"]).args).toContain(
        "run list --repo o/r --workflow ci.yml --commit abc123 --json event,status,conclusion",
      );
    });

    test("passes at once when the newest CI run on the commit passed", () => {
      expect(runGate(["push completed success\npush completed failure"])).toMatchObject({ status: 0, sleeps: 0 });
    });

    test("waits while CI has not started or is running, then passes", () => {
      expect(runGate(["", "push queued ", "push in_progress ", "push completed success"])).toMatchObject({
        status: 0,
        sleeps: 3,
      });
    });

    test("waits on a newer run past an older failed one", () => {
      expect(
        runGate(["push in_progress \npush completed failure", "push completed success\npush completed failure"]),
      ).toMatchObject({ status: 0, sleeps: 1 });
    });

    test("does not count a pull_request run, which tests a merge and on a draft skips the upgrade rehearsal", () => {
      expect(
        runGate([
          "pull_request completed success\npush in_progress ",
          "pull_request completed success\npush completed failure",
        ]),
      ).toMatchObject({ status: 1, sleeps: 1 });
      const prOnly = runGate(["pull_request completed success"]);
      expect(prOnly).toMatchObject({ status: 1, sleeps: 50 });
      expect(prOnly.stderr).toContain("no push or manual CI run yet");
    });

    test("fails when the newest CI run failed or was cancelled", () => {
      expect(runGate(["push completed failure\npush completed success"])).toMatchObject({ status: 1, sleeps: 0 });
      const cancelled = runGate(["push in_progress ", "push completed cancelled"]);
      expect(cancelled).toMatchObject({ status: 1, sleeps: 1 });
      expect(cancelled.stderr).toContain("CI did not pass on abc123: completed cancelled");
    });

    test("fails after 25 minutes of 30-second polls, naming the commit and the last status", () => {
      const result = runGate(["workflow_dispatch in_progress "]);
      expect(result).toMatchObject({ status: 1, sleeps: 50 });
      expect(result.stderr).toContain("CI has not passed on abc123 within 25 minutes; last status: in_progress");
      expect(gate?.run).toContain("sleep 30");
    });
  });
});
