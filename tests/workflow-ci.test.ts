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
  jobs: Record<string, { if?: string; needs?: string; uses?: string; steps?: Array<{ name?: string; run?: string }> }>;
};

// A draft pull request into main is the release pull request opened early: nothing runs on it until it is ready.
const DRAFT_RELEASE_PULL_REQUEST =
  "github.event_name == 'pull_request' && github.base_ref == 'main' && github.event.pull_request.draft";

describe("CI workflow", () => {
  test("runs on every pull request, whatever its base, on dispatch, and when Release calls it; never on a push", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "workflow_call", "workflow_dispatch"]);
    // No base filter (a pull request into a release branch or a feature branch runs it) and no path filter (a
    // required check that path filtering skips never reports, and blocks the merge). Marking a draft ready runs it.
    expect(workflow.on.pull_request).toEqual({ types: ["opened", "synchronize", "reopened", "ready_for_review"] });
  });

  test("the fast gate runs on every pull request except a draft into main: check, Desktop", () => {
    for (const job of ["check", "desktop"]) {
      expect(workflow.jobs[job]?.if, job).toBe(`$` + `{{ !(${DRAFT_RELEASE_PULL_REQUEST}) }}`);
      expect(workflow.jobs[job]?.needs, job).toBeUndefined();
    }
    expect(workflow.jobs.check?.steps?.some((step) => step.run === "bun run check")).toBe(true);
  });

  test("the desktop job runs Desktop's check and build, and none of its tests: they gate releases, from release.yml", () => {
    const steps = workflow.jobs.desktop?.steps ?? [];
    expect(steps.some((step) => step.run === "bun run desktop:setup")).toBe(true);
    const run = steps.find((step) => step.name === "Check and build Desktop")?.run ?? "";
    expect(run).toContain("npm run check");
    expect(run).toContain("npm run build");
    const desktopSource = JSON.stringify(steps);
    for (const command of [
      "npm test",
      "test:e2e",
      "test:usability",
      "test:server",
      "test:web-package",
      "test:electron",
    ]) {
      expect(desktopSource, command).not.toContain(command);
    }
    expect(desktopSource).not.toContain("playwright");
    expect(desktopSource).not.toContain("electron/install.js");
  });

  test("runs neither the integration suite nor Gated CI: they gate releases only, from release.yml", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.check).not.toContain("test:integration");
    expect(source).not.toContain("test:integration");
    expect(source).not.toContain("gated-ci.yml");
    // The Node fallback smoke and the upgrade rehearsals run integration tests: they are Release jobs too.
    expect(workflow.jobs["node-smoke"]).toBeUndefined();
    expect(workflow.jobs["upgrade-rehearsal"]).toBeUndefined();
    expect(source).not.toContain("test:node-smoke");
    expect(source).not.toContain("test:node-compat");
    expect(source).not.toContain("tests/integration/upgrade-rehearsal/");
  });

  test("only a release branch merges to main, and it ships the version it is named for", () => {
    // A pull request into main is a release (docs/maintainers/release-checklist.md). This check runs there only,
    // once the pull request is ready; the ruleset on main requires it, and a skipped `needs` would skip the
    // platform jobs below.
    const guard = workflow.jobs["release-branch-only"];
    expect(guard?.if).toBe(
      "github.event_name == 'pull_request' && github.base_ref == 'main' && !github.event.pull_request.draft",
    );
    const run = guard?.steps?.find((step) => step.run)?.run ?? "";
    expect(run).toContain("release/*)");
    expect(run).toContain(`VERSION="$(node -p "require('./package.json').version")"`);
    expect(run).toContain('[ "$VERSION" != "$' + '{HEAD#release/}" ]');
  });

  test("the platform jobs and the plugins contract follow the release-branch check, so they run on a release pull request only", () => {
    for (const job of ["desktop-package", "plugins-contract"]) {
      expect(workflow.jobs[job]?.needs, job).toBe("release-branch-only");
      expect(workflow.jobs[job]?.if, job).toBeUndefined();
    }
  });

  test("one run per pull request; a dispatch, a call from Release or a skipped draft run cancels nothing", () => {
    // A called workflow reports the caller's name in github.workflow, so a ref-based group shared with Release
    // would cancel the Release run; the run id keeps every non-pull-request run in a group of its own. A draft run
    // into main gets its own group too: release:stable pushes then marks the pull request ready, and the push's
    // all-skipped run can start after the ready run and would cancel the full gate.
    expect(workflow.concurrency.group).toBe(
      "$" +
        "{{ github.workflow }}-$" +
        "{{ (github.base_ref == 'main' && github.event.pull_request.draft) && github.run_id || github.event.pull_request.number || github.run_id }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  });
});
