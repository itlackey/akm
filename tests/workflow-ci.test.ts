// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const source = fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/ci.yml"), "utf8");
const workflow = YAML.parse(source) as {
  on: Record<string, unknown>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { if?: string; uses?: string; steps?: Array<{ run?: string }> }>;
};

// A pull request into main is a release (docs/maintainers/release-checklist.md): the platform jobs run there only.
const RELEASE_PULL_REQUEST = "github.event_name == 'pull_request' && github.base_ref == 'main'";

describe("CI workflow", () => {
  test("runs on every pull request, whatever its base, on dispatch, and when Release calls it; never on a push", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "workflow_call", "workflow_dispatch"]);
    // No base filter (a pull request into a release branch or a feature branch runs it) and no path filter (a
    // required check that path filtering skips never reports, and blocks the merge).
    expect(workflow.on.pull_request).toBeNull();
    expect(source).not.toContain("paths-ignore");
  });

  test("the fast gate runs unconditionally: check, the Node smoke on both versions, Desktop on Linux", () => {
    for (const job of ["check", "node-smoke", "desktop"]) {
      expect(workflow.jobs[job]?.if, job).toBeUndefined();
    }
    expect(source).toContain('node-version: ["22", "24"]');
    expect(workflow.jobs.check?.steps?.some((step) => step.run === "bun run check")).toBe(true);
  });

  test("the platform jobs and Gated CI run on a release pull request only", () => {
    for (const job of ["desktop-package", "upgrade-rehearsal", "gated"]) {
      expect(workflow.jobs[job]?.if, job).toBe(RELEASE_PULL_REQUEST);
    }
    expect(workflow.jobs.gated?.uses).toBe("./.github/workflows/gated-ci.yml");
  });

  test("only a release branch merges to main", () => {
    const guard = workflow.jobs["release-branch-only"];
    expect(guard?.if).toBe(RELEASE_PULL_REQUEST);
    const run = guard?.steps?.[0]?.run ?? "";
    expect(run).toContain("release/*)");
    expect(run).toContain("exit 1");
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
