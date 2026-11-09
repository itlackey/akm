// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { WORKFLOWS_DIR } from "./_helpers/pinned-action";

const source = fs.readFileSync(path.join(WORKFLOWS_DIR, "ci.yml"), "utf8");
const workflow = YAML.parse(source) as {
  on: Record<string, unknown>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { if?: string; needs?: string; uses?: string; steps?: Array<{ run?: string }> }>;
};

describe("CI workflow", () => {
  test("runs on every pull request, whatever its base, on dispatch, and when Release calls it; never on a push", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "workflow_call", "workflow_dispatch"]);
    // No base filter (a pull request into a release branch or a feature branch runs it) and no path filter (a
    // required check that path filtering skips never reports, and blocks the merge).
    expect(workflow.on.pull_request).toBeNull();
  });

  test("the fast gate runs unconditionally: check, the Node smoke on both versions, Desktop on Linux", () => {
    for (const job of ["check", "node-smoke", "desktop"]) {
      expect(workflow.jobs[job]?.if, job).toBeUndefined();
      expect(workflow.jobs[job]?.needs, job).toBeUndefined();
    }
    expect(source).toContain('node-version: ["22", "24"]');
    expect(workflow.jobs.check?.steps?.some((step) => step.run === "bun run check")).toBe(true);
  });

  test("only a release branch merges to main, and it ships the version it is named for", () => {
    // A pull request into main is a release (docs/maintainers/release-checklist.md). This check runs there only;
    // the ruleset on main requires it, and a skipped `needs` would skip the platform jobs below.
    const guard = workflow.jobs["release-branch-only"];
    expect(guard?.if).toBe("github.event_name == 'pull_request' && github.base_ref == 'main'");
    const run = guard?.steps?.find((step) => step.run)?.run ?? "";
    expect(run).toContain("release/*)");
    expect(run).toContain(`VERSION="$(node -p "require('./package.json').version")"`);
    expect(run).toContain('[ "$VERSION" != "$' + '{HEAD#release/}" ]');
  });

  test("the platform jobs and Gated CI follow the release-branch check, so they run on a release pull request only", () => {
    for (const job of ["desktop-package", "upgrade-rehearsal", "gated"]) {
      expect(workflow.jobs[job]?.needs, job).toBe("release-branch-only");
      expect(workflow.jobs[job]?.if, job).toBeUndefined();
    }
    expect(workflow.jobs.gated?.uses).toBe("./.github/workflows/gated-ci.yml");
  });

  test("one run per pull request; a dispatch or a call from Release cancels nothing", () => {
    // A called workflow reports the caller's name in github.workflow, so a ref-based group shared with Release
    // would cancel the Release run; the run id keeps every non-pull-request run in a group of its own.
    expect(workflow.concurrency.group).toBe(
      "$" + "{{ github.workflow }}-$" + "{{ github.event.pull_request.number || github.run_id }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  });
});
