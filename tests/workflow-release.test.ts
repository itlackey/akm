// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { KNOWN_UPGRADE_ORIGINS } from "./integration/upgrade-rehearsal/previous-release";

const source = fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const STAGE_INPUT = "$" + "{{ inputs.stage }}";

type Step = {
  id?: string;
  name?: string;
  if?: string;
  "continue-on-error"?: boolean;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, string>;
};
type Job = {
  uses?: string;
  needs?: string | string[];
  if?: string;
  permissions?: unknown;
  steps?: Step[];
  outputs?: Record<string, string>;
  strategy?: { matrix: Record<string, string[]> };
};
const workflow = YAML.parse(source) as {
  on: {
    push: { branches: string[] };
    pull_request: { branches: string[]; types: string[] };
    workflow_dispatch: { inputs: Record<string, { type: string; default?: unknown; options?: string[] }> };
  };
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, Job>;
};
// The gate jobs run for a dispatch (not a dry run), for a release pull request (ready, from a release/* branch), and
// for the push to main unless `proven` found the same tree already passed them. Nothing else runs them.
const GATES = [
  "integration",
  "node-smoke",
  "upgrade-rehearsal",
  "desktop-tests",
  "desktop-e2e",
  "desktop-usability",
  "gated",
];
const GATE_IF =
  "$" +
  "{{ !cancelled() && !inputs.dry_run && needs.proven.outputs.skip != 'true' && " +
  "(github.event_name != 'pull_request' || (!github.event.pull_request.draft && startsWith(github.head_ref, 'release/'))) }}";
const resolve = workflow.jobs.release?.steps?.find((step) => step.name === "Resolve version");

describe("release workflow", () => {
  test("a stable release is the push that merges a release branch into main; a prerelease is a dispatch with a stage", () => {
    expect(Object.keys(workflow.on)).toEqual(["push", "pull_request", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    // The release pull request runs the gates; marking a draft ready runs them once.
    expect(workflow.on.pull_request).toEqual({
      branches: ["main"],
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
    });
    // No version input: the version is the one committed in package.json.
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["stage", "dry_run"]);
    expect(workflow.on.workflow_dispatch.inputs.stage).toMatchObject({
      type: "choice",
      default: "beta",
      options: ["alpha", "beta", "rc"],
    });
  });

  test("its concurrency group never matches the group of the CI it calls", () => {
    // A called workflow evaluates github.workflow and github.run_id as the caller's, so ci.yml's group on a dispatch is
    // `Release-<run id>`. A Release group of that shape puts both in one group, and GitHub cancels the run as a deadlock.
    const ciGroup = (
      YAML.parse(fs.readFileSync(path.resolve(import.meta.dir, "../.github/workflows/ci.yml"), "utf8")) as {
        concurrency: { group: string };
      }
    ).concurrency.group;
    expect(ciGroup.startsWith("$" + "{{ github.workflow }}-")).toBe(true);
    expect(workflow.concurrency.group).toBe(
      "release-workflow-$" + "{{ github.event.pull_request.number || github.run_id }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe("$" + "{{ github.event_name == 'pull_request' }}");
  });

  test("runs the gates as its own jobs, then one release job, then Desktop and akm-web", () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      "ci",
      "proven",
      "integration",
      "node-smoke",
      "upgrade-rehearsal",
      "desktop-tests",
      "desktop-e2e",
      "desktop-usability",
      "gated",
      "release",
      "desktop",
      "akm-web",
    ]);
    expect(workflow.jobs.ci?.uses).toBe("./.github/workflows/ci.yml");
    expect(workflow.jobs.gated?.uses).toBe("./.github/workflows/gated-ci.yml");
    expect(workflow.jobs.integration?.steps?.some((step) => step.run === "bun run test:integration")).toBe(true);
    expect(workflow.jobs.release?.needs).toEqual([
      "ci",
      "integration",
      "node-smoke",
      "upgrade-rehearsal",
      "desktop-tests",
      "desktop-e2e",
      "desktop-usability",
      "gated",
    ]);
    expect(workflow.jobs.desktop?.needs).toBe("release");
    expect(workflow.jobs["akm-web"]?.needs).toBe("release");
    // The merge that makes a stable passed CI on its pull request: only a dispatch runs it here.
    expect(workflow.jobs.ci?.if).toBe("$" + "{{ github.event_name == 'workflow_dispatch' && !inputs.dry_run }}");
    // The integration suite, the Node fallback smoke, the upgrade rehearsals and Gated CI run nowhere else, so they
    // gate the stable push and the prerelease alike.
    for (const gate of GATES) {
      expect(workflow.jobs[gate]?.if, gate).toBe(GATE_IF);
      expect(workflow.jobs[gate]?.needs, gate).toBe("proven");
    }
    // The Node fallback on both supported Node versions; one rehearsal per KNOWN_UPGRADE_ORIGINS entry.
    expect(workflow.jobs["node-smoke"]?.strategy?.matrix["node-version"]).toEqual(["22", "24"]);
    expect(workflow.jobs["node-smoke"]?.steps?.find((step) => step.name === "Verify the Node fallback")?.run).toContain(
      "bun run test:node-smoke",
    );
    expect(workflow.jobs["upgrade-rehearsal"]?.strategy?.matrix.origin).toEqual([...KNOWN_UPGRADE_ORIGINS]);
    expect(source).toContain("tests/integration/upgrade-rehearsal/");
    // A skipped gate (CI for a stable, every gate for a dry run) lets the release go on; a failed or cancelled one
    // stops it.
    expect(workflow.jobs.release?.if).toContain("!contains(needs.*.result, 'failure')");
    expect(workflow.jobs.release?.if).toContain("!contains(needs.*.result, 'cancelled')");
    // Nothing polls another workflow's run.
    expect(source).not.toContain("gh run list");
    expect(source).toContain("bun install --frozen-lockfile");
    expect(source).toContain("bun run build");
    expect(source).toContain("npm publish");
    expect(source).toContain("gh release create");
  });

  test("the integration matrix runs every shard of one plan exactly once", () => {
    const job = workflow.jobs.integration as { strategy?: { matrix?: { shards?: string[] } } } | undefined;
    const step = workflow.jobs.integration?.steps?.find((s) => s.run === "bun run test:integration") as
      | { env?: Record<string, string | number> }
      | undefined;
    const total = Number(step?.env?.TEST_SHARDS);
    const covered = (job?.strategy?.matrix?.shards ?? []).flatMap((range) => {
      const [first, last] = range.split("-").map(Number) as [number, number];
      return Array.from({ length: last - first + 1 }, (_, i) => first + i);
    });
    expect(covered).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(step?.env?.TEST_SHARD_RANGE).toBe("$" + "{{ matrix.shards }}");
  });

  test("the integration and Node smoke jobs share a cache for the pinned OpenCode binary", () => {
    const caches = ["integration", "node-smoke"].map((id) => {
      const steps = workflow.jobs[id]?.steps ?? [];
      const cacheIndex = steps.findIndex((step) => step.with?.path === "node_modules/.cache/akm-test-opencode");
      const cache = steps[cacheIndex];
      expect(cache?.uses).toMatch(/^actions\/cache@[0-9a-f]{40}$/);
      expect(cacheIndex).toBeLessThan(steps.findIndex((step) => step.run?.includes("bun run test:")));
      expect(cache?.with?.key).toContain("src/integrations/harnesses/opencode/runtime/binary.ts");
      return cache?.with?.key;
    });
    expect(caches[0]).toBe(caches[1]);
  });

  test("Desktop's tests gate the release as three parallel jobs: every command runs once, on the commit that ships", () => {
    const commands: Record<string, string[]> = {
      "desktop-tests": [
        "npm run check",
        "npm run build",
        "npm test",
        "npm run test:server",
        "npm run test:web-package",
        "xvfb-run -a npm run test:electron",
      ],
      "desktop-e2e": ["npm run test:e2e"],
      "desktop-usability": ["npm run test:usability"],
    };
    const everything: string[] = [];
    for (const [id, expected] of Object.entries(commands)) {
      const job = workflow.jobs[id];
      expect(job?.permissions, id).toEqual({ contents: "read" });
      const run = (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
      for (const command of expected) {
        expect(run, `${id}: ${command}`).toContain(command);
      }
      // The same setup in each job.
      expect(
        job?.steps?.some((step) => step.run === "bun run desktop:setup"),
        id,
      ).toBe(true);
      const cache = job?.steps?.find((step) => step.id === "desktop-downloads");
      expect(cache?.uses, id).toMatch(/^actions\/cache@[0-9a-f]{40}$/);
      expect(cache?.with?.path, id).toContain("~/.cache/ms-playwright");
      const deps = job?.steps?.find((step) => step.run?.includes("playwright/test/cli.js install-deps chromium"));
      expect(deps, id).toBeDefined();
      expect(deps?.if, id).toBeUndefined();
      const download = job?.steps?.find((step) => step.run?.includes("playwright/test/cli.js install chromium"));
      expect(download?.if, id).toBe("steps.desktop-downloads.outputs.cache-hit != 'true'");
      everything.push(...(run.match(/npm (?:run [\w:-]+|test)\b/g) ?? []));
    }
    for (const command of ["npm run test:e2e", "npm run test:usability", "npm test", "npm run test:electron"]) {
      expect(everything.filter((found) => found === command).length, command).toBe(1);
    }
  });

  test("the gates run on the release pull request only, and the release job never runs there", () => {
    expect(workflow.jobs.release?.if).toContain("github.event_name != 'pull_request'");
    // Nothing is built for publishing, tagged or published on a pull request: release, desktop and akm-web all hang
    // off the release job.
    expect(workflow.jobs.desktop?.needs).toBe("release");
    expect(workflow.jobs["akm-web"]?.needs).toBe("release");
    expect(workflow.jobs.ci?.if).toContain("github.event_name == 'workflow_dispatch'");
  });

  test("the push to main skips the gates when the merged tree already passed them on the release pull request", () => {
    const proven = workflow.jobs.proven;
    expect(proven?.if).toBe("$" + "{{ github.event_name == 'push' }}");
    expect(proven?.outputs).toEqual({ skip: "$" + "{{ steps.proof.outputs.skip }}" });
    expect(proven?.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
    const run = proven?.steps?.find((step) => step.name === "Look for a passing run on this tree")?.run ?? "";
    // The merged pull request's head, from a release branch into main; the trees compared through the API.
    expect(run).toContain("commits/$GITHUB_SHA/pulls");
    expect(run).toContain('.base.ref == "main"');
    expect(run).toContain('startswith("release/")');
    expect(run).toContain(".tree.sha");
    // The pull request's own Release run on that head: nothing failed, and the integration job really ran (a draft
    // run is all skipped).
    expect(run).toContain("workflows/release.yml/runs?event=pull_request&head_sha=");
    expect(run).toContain('(.name | startswith("integration (")) and .conclusion == "success"');
    expect(run).toContain('.conclusion == "success" or .conclusion == "skipped"');
    // Only a proof sets it: no proof, or a failed lookup, runs the gates as before.
    expect(run).toContain('echo "skip=true" >> "$GITHUB_OUTPUT"');
    expect(run).not.toContain("exit 1");
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
  });

  test("a stable is `latest`; a prerelease is `next` unless a newer line's prerelease already holds it", () => {
    const choose = workflow.jobs.release?.steps?.find((step) => step.name === "Choose the npm dist-tag");
    expect(choose?.run).toContain("DIST_TAG=latest");
    expect(choose?.run).toContain("DIST_TAG=next");
    expect(choose?.run).toContain("npm view akm-cli dist-tags.next");
    expect(choose?.run).toContain('require("semver").gt(process.argv[1], process.argv[2])');
    // An older line's prerelease gets its line's tag, so `next` never moves backwards.
    expect(choose?.run).toContain('DIST_TAG="next-$(cut -d. -f1,2 <<<"$CANDIDATE_VERSION")"');
    // akm-web publishes under the tag the release job chose.
    expect(source).toContain("dist_tag: $" + "{{ steps.dist-tag.outputs.dist_tag }}");
    expect(source).toContain("DIST_TAG: $" + "{{ needs.release.outputs.dist_tag }}");
  });

  test("a stable at or above `next` moves `next` to it, for akm-cli and then akm-web, without stopping the release", () => {
    const steps = workflow.jobs.release?.steps ?? [];
    const next = steps.find((step) => step.name === "Point next at the stable");
    expect(next?.if).toContain("env.DIST_TAG == 'latest'");
    expect(next?.["continue-on-error"]).toBe(true);
    expect(next?.run).toContain('require("semver").gte(process.argv[1], process.argv[2])');
    expect(next?.run).toContain('npm dist-tag add "akm-cli@$CANDIDATE_VERSION" next');
    // It runs after the publish, in the job whose trusted publisher authenticates it.
    expect(steps.findIndex((step) => step.name === "Publish to npm")).toBeLessThan(steps.indexOf(next as never));
    expect(source).toContain("next_follows: $" + "{{ steps.next.outputs.next_follows }}");
    const web = workflow.jobs["akm-web"]?.steps?.find((step) => step.name === "Point akm-web's next at the stable");
    expect(web?.if).toContain("needs.release.outputs.next_follows == 'true'");
    expect(web?.["continue-on-error"]).toBe(true);
    expect(web?.run).toContain("npm install -g npm@latest");
    expect(web?.run).toContain('@$VERSION" next');
  });

  test("a stable is GitHub's Latest release only when it is higher than the one that is", () => {
    // GitHub makes every newly published stable release Latest, whatever its version, and AKM Desktop's stable line
    // reads Latest: an older line's stable published after a newer line's must not take it.
    const create = workflow.jobs.release?.steps?.find((step) => step.name === "Create GitHub release");
    expect(create?.run).toContain("gh release view --json tagName --jq .tagName");
    expect(create?.run).toContain('require("semver").gt(process.argv[1], process.argv[2])');
    expect(create?.run).toContain("FLAGS=(--latest=false)");
    expect(create?.run).toContain("FLAGS=(--prerelease)");
    expect(create?.run).toContain('"$' + '{FLAGS[@]}"');
  });

  test("the changelog is cut: its newest released section names the shipping version", () => {
    // The release-cut step nothing else enforces. `release.yml` publishes the
    // committed package.json version, and the test above pins that — but
    // nothing checks the CHANGELOG was cut alongside it, and the failure is
    // silent and shipped: `resolveLatestVersion()`
    // (src/commands/sources/migration-help.ts) resolves release notes by
    // SKIPPING the `## [Unreleased]` heading, so a released binary whose
    // changelog still says `Unreleased` answers `akm help migrate latest` with
    // the PREVIOUS release's notes.
    //
    // Lives here rather than beside the renderer's own tests because this is a
    // property of the release, not of `renderMigrationHelp`. CI runs it on the
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
    expect(skipped("release")).toEqual(["Publish to npm", "Point next at the stable", "Create GitHub release"]);
    expect(skipped("desktop")).toEqual(["Attach Desktop to the GitHub release"]);
    expect(skipped("akm-web")).toEqual(["Publish akm-web to npm", "Point akm-web's next at the stable"]);
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
