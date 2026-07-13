// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const ROOT = path.resolve(import.meta.dir, "..");
const REF_INPUT = "ref: $" + "{{ github.sha }}";
const REF_INPUT_OR_SHA = "ref: $" + "{{ inputs.ref || github.sha }}";
const BRANCH_REF = "ref: $" + "{{ github.ref_name }}";
const VERSION_INPUT = "version: $" + "{{ inputs.version }}";
const VERSION_EXPRESSION = "$" + "{{ inputs.version }}";
const RUNNER_TEMP_EXPRESSION = "$" + "{{ runner.temp }}";
const MATRIX_ARCH_EXPRESSION = "AKM_CANDIDATE_ARCH: $" + "{{ matrix.arch }}";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function job(source: string, id: string): string {
  const match = source.match(new RegExp(`^  ${id}:\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:\\n|$(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`Missing workflow job: ${id}`);
  return match[0];
}

function shellSources(source: string): string[] {
  const runs: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "run" && typeof child === "string") runs.push(child);
      else visit(child);
    }
  };
  visit(YAML.parse(source));
  return runs;
}

function stepRun(source: string, jobId: string, stepName: string): string {
  const parsed = YAML.parse(source) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const step = parsed.jobs?.[jobId]?.steps?.find((candidate) => candidate.name === stepName);
  if (!step?.run) throw new Error(`Missing workflow step: ${jobId} / ${stepName}`);
  return step.run;
}

describe("release candidate workflow wiring", () => {
  const release = read(".github/workflows/release.yml");
  const releaseGates = read(".github/workflows/release-gates.yml");
  const schedulerGates = read(".github/workflows/task-upgrade-scheduler-gates.yml");
  const syntaxGuard = read(".github/workflows/release-workflow-syntax.yml");
  const releaseCheck = read("tests/release-check.sh");

  test("builds versioned package and binary candidates once inside the reusable gate", () => {
    expect(schedulerGates).toContain("workflow_call:\n    inputs:");
    expect(schedulerGates).toContain("ref:");
    expect(schedulerGates).toContain("version:");
    expect(schedulerGates).toContain("name: akm-package-candidate");
    expect(schedulerGates.match(/bun run build/g) ?? []).toHaveLength(1);
    expect(schedulerGates.match(/bun build \.\/src\/cli\.ts/g) ?? []).toHaveLength(1);
    for (const artifact of [
      "akm-linux-x64",
      "akm-linux-arm64",
      "akm-darwin-x64",
      "akm-darwin-arm64",
      "akm-windows-x64.exe",
    ]) {
      expect(schedulerGates).toContain(`artifact: ${artifact}`);
    }

    const publishedUpgrade = job(schedulerGates, "published-upgrade");
    expect(publishedUpgrade).toContain("needs: package-candidate");
    expect(publishedUpgrade).toContain("name: akm-package-candidate");
    expect(publishedUpgrade).toContain("AKM_PUBLISHED_UPGRADE_TARBALL");
    expect(publishedUpgrade).not.toContain("bun run build");

    for (const id of ["linux-standalone", "macos-launchd", "windows-task-scheduler"]) {
      const scheduler = job(schedulerGates, id);
      expect(scheduler).toContain("binary-candidates");
      expect(scheduler).toContain("actions/download-artifact@");
      expect(scheduler).toContain("AKM_CANDIDATE_VERSION");
      expect(scheduler).not.toContain("bun build");
    }
  });

  test("orders candidate gates after ordinary release tests and promotes their artifacts", () => {
    const heavyGates = job(release, "release-gates");
    expect(heavyGates).toContain("needs: [lint, test-unit, test-integration]");
    expect(heavyGates).toContain("uses: ./.github/workflows/release-gates.yml");
    expect(heavyGates).toContain(REF_INPUT);
    expect(heavyGates).toContain(VERSION_INPUT);

    const version = job(release, "version");
    expect(version).toContain("needs: [lint, test-unit, test-integration, release-gates]");
    expect(version).toContain(BRANCH_REF);
    expect(version).toContain("fetch-depth: 2");
    expect(version).toContain('git diff --name-only "$SOURCE_SHA" "$HEAD_SHA"');
    expect(version).toContain('"$CHANGED_FILES" != "package.json"');

    const publish = job(release, "publish");
    expect(publish).toContain("needs: [version, release-gates]");
    expect(publish).toContain("name: akm-package-candidate");
    expect(publish).toContain('npm publish "$TARBALL"');
    expect(publish).toContain("dist.integrity");
    expect(publish).toContain('createHash("sha512")');
    expect(publish).toContain("Candidate integrity mismatch");
    expect(publish).toContain("--ignore-scripts");
    expect(publish).not.toContain("bun run build");
    expect(publish).not.toContain("bun install");
    expect(release).not.toMatch(/^ {2}build:\n/m);

    const githubRelease = job(release, "github-release");
    expect(githubRelease).toContain("needs: [version, publish]");
    for (const artifact of [
      "akm-linux-x64",
      "akm-linux-arm64",
      "akm-darwin-x64",
      "akm-darwin-arm64",
      "akm-windows-x64.exe",
    ]) {
      expect(githubRelease).toContain(artifact);
    }
  });

  test("protects every privileged release mutation with repository approval", () => {
    expect(release).toContain("Repository settings must protect the `release` environment with required reviewers");
    for (const id of ["version", "publish", "github-release"]) {
      expect(job(release, id)).toContain("environment: release");
    }
  });

  test("checksums and uploads every ARM64 release asset", () => {
    const checksums = stepRun(release, "github-release", "Generate checksums");
    const upload = stepRun(release, "github-release", "Create GitHub release");
    const uploadFunction = upload.match(/upload_assets\(\) \{[\s\S]*?\n\s*\}/)?.[0] ?? "";
    const createCommand = upload.match(/gh release create[\s\S]*?; then/)?.[0] ?? "";

    for (const artifact of [
      "artifacts/akm-linux-arm64/akm-linux-arm64",
      "artifacts/akm-darwin-arm64/akm-darwin-arm64",
    ]) {
      expect(checksums).toContain(artifact);
      expect(uploadFunction).toContain(artifact);
      expect(createCommand).toContain(artifact);
    }
  });

  test("retries missing registry integrity but fails on mismatch or exhaustion", () => {
    const publish = stepRun(release, "publish", "Publish attested package candidate to npm");
    const retry = publish.match(/retry_published_candidate\(\) \{[\s\S]*?\n\s*\}/)?.[0] ?? "";

    expect(retry).toContain("for attempt in 1 2 3 4 5");
    expect(retry).toContain("if verify_published_candidate; then");
    expect(retry).toContain("verify_status=$?");
    expect(retry).toContain('if [ "$verify_status" -eq 2 ]; then');
    expect(retry).toContain("return 2");
    expect(retry).toContain("return 1");
    expect(publish).toContain('echo "Published candidate integrity remained unavailable after retries."');
    expect(publish).toContain('echo "Published candidate does not match the immutable package candidate."');
  });

  test("manual release gates supply an explicit candidate ref and version", () => {
    expect(releaseGates).toContain("workflow_call:\n    inputs:");
    expect(releaseGates).toContain("workflow_dispatch:\n    inputs:");
    expect(releaseGates).toContain("description: Exact candidate version to validate");
    const candidate = job(releaseGates, "task-upgrade-scheduler");
    expect(candidate).toContain("needs: integration");
    expect(candidate).toContain(REF_INPUT_OR_SHA);
    expect(candidate).toContain(VERSION_INPUT);
  });

  test("makes every heavy gate block publication through the reusable workflow", () => {
    for (const id of [
      "integration",
      "flake-detect",
      "node-smoke",
      "semantic-search",
      "docker-install",
      "task-upgrade-scheduler",
    ]) {
      expect(() => job(releaseGates, id)).not.toThrow();
      expect(job(releaseGates, id)).not.toContain("continue-on-error: true");
    }
  });

  test("runs Node compatibility at the exact minimum supported Node release", () => {
    const nodeSmoke = job(releaseGates, "node-smoke");
    expect(nodeSmoke).toContain("node-version: [20.12.0, 22]");
    expect(nodeSmoke).not.toContain("continue-on-error: true");
    expect(nodeSmoke).toContain("bun run test:node-compat");
  });

  test("keeps untrusted versions out of shell source and validates the environment value first", () => {
    for (const source of [release, releaseGates, schedulerGates]) {
      for (const shell of shellSources(source)) expect(shell).not.toContain(VERSION_EXPRESSION);
    }
    expect(release).toContain(`CANDIDATE_VERSION: ${VERSION_EXPRESSION}`);
    expect(schedulerGates).toContain(`CANDIDATE_VERSION: ${VERSION_EXPRESSION}`);
    expect(release).toContain("Invalid candidate version");
    expect(schedulerGates).toContain("Invalid candidate version");
  });

  test("uses step-time runner directories and validates workflow syntax before release checks", () => {
    for (const source of [release, releaseGates, schedulerGates, syntaxGuard]) {
      expect(() => YAML.parse(source)).not.toThrow();
    }
    expect(schedulerGates).not.toContain(RUNNER_TEMP_EXPRESSION);
    expect(syntaxGuard).toContain("ACTIONLINT_VERSION: 1.7.12");
    expect(syntaxGuard).toContain("./actionlint");
    expect(releaseCheck).toContain('version="1.7.12"');
    expect(releaseCheck.indexOf('"Workflow Syntax"')).toBeLessThan(releaseCheck.indexOf('"Workflow Release Contract"'));
  });

  test("allows immutable candidate artifact uploads to be safely retried", () => {
    expect(job(schedulerGates, "package-candidate")).toContain("overwrite: true");
    expect(job(schedulerGates, "binary-candidates")).toContain("overwrite: true");
  });

  test("executes every released ARM64 candidate on a matching native runner", () => {
    const linux = job(schedulerGates, "linux-standalone");
    expect(linux).toContain("runner: ubuntu-24.04-arm");
    expect(linux).toContain("artifact: akm-linux-arm64");
    expect(linux).toContain(MATRIX_ARCH_EXPRESSION);

    const macos = job(schedulerGates, "macos-launchd");
    expect(macos).toContain("runner: macos-15");
    expect(macos).toContain("artifact: akm-darwin-arm64");
    expect(macos).toContain(MATRIX_ARCH_EXPRESSION);
  });

  test("cleans only the exact native gate ID and uniquely owned gate directory", () => {
    expect(schedulerGates).toContain("AKM_NATIVE_TASK_ID");
    expect(schedulerGates).toContain("AKM_NATIVE_GATE_DIR");
    for (const id of ["macos-launchd", "windows-task-scheduler"]) {
      const scheduler = job(schedulerGates, id);
      expect(scheduler).toContain("if: always()");
      expect(scheduler).toContain("AKM_NATIVE_TASK_ID");
    }
    expect(job(schedulerGates, "windows-task-scheduler")).toContain("AKM_NATIVE_NODE_TASK_ID");
    expect(schedulerGates).not.toMatch(/akm-ci-(darwin|win32)-\*/);
    expect(schedulerGates).not.toContain("$HOME/.config/akm");
    expect(schedulerGates).not.toContain("$HOME/.local/share/akm");
    expect(schedulerGates).not.toContain("$HOME/.cache/akm");
    expect(schedulerGates).not.toContain("$env:APPDATA\\akm");
    expect(schedulerGates).not.toContain("$env:LOCALAPPDATA\\akm");
  });
});

describe("candidate artifact acceptance tests", () => {
  const publishedUpgrade = read("tests/integration/published-task-upgrade.test.ts");
  const nativeScheduler = read("tests/integration/native-scheduler.test.ts");
  const linuxScheduler = read("tests/integration/linux-standalone-scheduler.test.ts");
  const nodeCompat = read("tests/integration/node-compat.test.ts");
  const releaseCheck = read("tests/release-check.sh");

  test("uses the supplied package tarball without repacking the checkout", () => {
    expect(publishedUpgrade).toContain("AKM_PUBLISHED_UPGRADE_TARBALL");
    expect(publishedUpgrade).toContain('"akm-cli@0.8.14"');
    expect(publishedUpgrade).toContain("AKM_CANDIDATE_VERSION");
    expect(publishedUpgrade).not.toContain('run(["npm", "pack"');
    expect(releaseCheck).toContain("AKM_PUBLISHED_UPGRADE_TARBALL=");
  });

  test("uses an explicit candidate version beyond 0.9 but defaults this migration gate to 0.9", () => {
    const exact = "if (expectedVersion) expect(candidatePackage.version).toBe(expectedVersion);";
    const migrationDefault = "else expect(candidatePackage.version).toMatch(/^0\\.9\\./);";
    expect(publishedUpgrade).toContain(exact);
    expect(publishedUpgrade).toContain(migrationDefault);
    expect(publishedUpgrade.indexOf(exact)).toBeLessThan(publishedUpgrade.indexOf(migrationDefault));
  });

  test("requires exact native scheduler ownership and candidate versions", () => {
    expect(nativeScheduler).toContain("AKM_NATIVE_TASK_ID");
    expect(nativeScheduler).toContain("AKM_NATIVE_GATE_DIR");
    expect(nativeScheduler).toContain("AKM_CANDIDATE_VERSION");
    expect(nativeScheduler).toContain("AKM_CANDIDATE_ARCH");
    expect(nativeScheduler).not.toContain("nativeDefaults(");
    expect(linuxScheduler).toContain("AKM_CANDIDATE_VERSION");
    expect(linuxScheduler).toContain("AKM_CANDIDATE_ARCH");
    expect(releaseCheck).toContain("AKM_CANDIDATE_ARCH=");
  });

  test("covers a packed Node scheduler on Windows with HOME absent and space-bearing paths", () => {
    const windows = job(read(".github/workflows/task-upgrade-scheduler-gates.yml"), "windows-task-scheduler");
    expect(windows).toContain("needs: [binary-candidates, package-candidate]");
    expect(windows).toContain("AKM_NATIVE_PACKED_BIN");
    expect(windows).toContain("akm packed npm");
    expect(windows).toContain("node_modules\\.bin\\akm.cmd");
    expect(nativeScheduler).toContain("delete env.HOME");
    expect(nativeScheduler).toContain("AKM_NATIVE_PACKED_BIN");
    expect(nativeScheduler).toContain("cli-node.mjs");
  });

  test("executes a generated scheduler command whose nested akm uses the Node fallback", () => {
    expect(nodeCompat).toContain("generated scheduler command runs a nested akm through the Node fallback");
    expect(nodeCompat).toContain("generatedCronCommand");
    expect(nodeCompat).toContain('"akm --version"');
  });

  test("runs this static contract and builds each local candidate before acceptance", () => {
    const staticCheck = releaseCheck.indexOf("tests/workflow-release-gates.test.ts");
    const packageBuild = releaseCheck.indexOf('"Build Package"');
    const packagePack = releaseCheck.indexOf('"Pack Package Candidate"');
    const packageGate = releaseCheck.indexOf('"Published 0.8 Task Upgrade"');
    const binaryBuild = releaseCheck.indexOf('"Build Linux Standalone Scheduler Artifact"');
    const binaryGate = releaseCheck.indexOf('"Linux Standalone Outside PATH"');
    expect(staticCheck).toBeGreaterThanOrEqual(0);
    expect(staticCheck).toBeLessThan(packageBuild);
    expect(packageBuild).toBeLessThan(packagePack);
    expect(packagePack).toBeLessThan(packageGate);
    expect(binaryBuild).toBeLessThan(binaryGate);
  });
});
