// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { RELEASE_GATES, requiredChecks } from "../scripts/github-settings";

const releaseJobs = Object.keys(
  (
    YAML.parse(fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8")) as {
      jobs: Record<string, unknown>;
    }
  ).jobs,
);

describe("scripts/github-settings.ts required checks", () => {
  const checks = requiredChecks();

  test("every check a release pull request reports from ci.yml is required", () => {
    for (const name of [
      "check",
      "release-branch-only",
      "desktop",
      "desktop-package (ubuntu-latest)",
      "desktop-package (macos-latest)",
      "desktop-package (windows-latest)",
      "plugins-contract",
    ]) {
      expect(checks, name).toContain(name);
    }
  });

  test("the release gates from release.yml are required, under the names GitHub reports", () => {
    for (const name of [
      "integration (1-2)",
      "integration (3-4)",
      "node-smoke (22)",
      "node-smoke (24)",
      "upgrade-rehearsal (previous)",
      "upgrade-rehearsal (0.9.32)",
      "upgrade-rehearsal (0.9.15)",
      "desktop-tests",
      "desktop-e2e",
      "desktop-usability",
      "gated / Gated / Semantic Search",
      "gated / Gated / Docker Install",
      "gated / Gated / Native Scheduler / Linux",
      "gated / Gated / Native Scheduler / macOS",
      "gated / Gated / Native Scheduler / Windows",
    ]) {
      expect(checks, name).toContain(name);
    }
  });

  test("nothing release.yml builds or publishes is required, and no name repeats", () => {
    for (const name of ["ci", "proven", "release", "desktop (ubuntu-latest)", "akm-web"]) {
      expect(checks, name).not.toContain(name);
    }
    expect(new Set(checks).size).toBe(checks.length);
  });

  test("every release.yml job is either a pull request gate or one of the jobs that never run on a pull request", () => {
    const notGates = ["ci", "proven", "release", "desktop", "akm-web"];
    expect([...RELEASE_GATES].sort()).toEqual(releaseJobs.filter((job) => !notGates.includes(job)).sort());
  });
});
