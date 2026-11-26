// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { mainRuleset, RELEASE_GATES, requiredChecks } from "../scripts/github-settings";

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

describe("mainRuleset", () => {
  test("sets every pull-request field the main ruleset has, so running the script resets none", () => {
    const rules = mainRuleset(["check"]).rules as Array<{ type: string; parameters?: Record<string, unknown> }>;
    expect(rules.find((rule) => rule.type === "pull_request")?.parameters).toEqual({
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      require_extra_approval_for_unattributed_changes: true,
      required_review_thread_resolution: false,
      allowed_merge_methods: ["merge"],
    });
  });
});
