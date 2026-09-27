import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { expectPinnedAction, expectPinnedVersion } from "./_helpers/pinned-action";

const ROOT = path.resolve(import.meta.dir, "..");

interface WorkflowStep {
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function runsBunInstall(run: string | undefined): boolean {
  return (run ?? "").split("\n").some((line) => {
    const command = line.trimStart();
    return !command.startsWith("#") && /(?:^|&&|\|\||;)\s*bun\s+install(?:\s|$)/.test(command);
  });
}

describe("Node 22 runtime minimum contract", () => {
  test("selects Node 24 with setup-node v5 before every workflow Bun install", () => {
    const workflowsDirectory = path.join(ROOT, ".github", "workflows");
    const coveredInstallJobs: string[] = [];

    for (const filename of fs
      .readdirSync(workflowsDirectory)
      .filter((file) => /\.ya?ml$/.test(file))
      .sort()) {
      const workflow = YAML.parse(fs.readFileSync(path.join(workflowsDirectory, filename), "utf8")) as Workflow;

      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        for (const [index, step] of (job.steps ?? []).entries()) {
          if (!runsBunInstall(step.run)) continue;

          const label = `${filename}#${jobId}`;
          coveredInstallJobs.push(label);
          const nodeSetup = [...(job.steps ?? [])]
            .slice(0, index)
            .reverse()
            .find((candidate) => candidate.uses?.startsWith("actions/setup-node@"));

          expect(nodeSetup, `${label} must select Node before bun install`).toBeDefined();
          // #768 pinned actions to commit SHAs, so the major version now lives
          // in the trailing comment. Assert BOTH halves of the original
          // contract — the right action, pinned; and still v5.
          expectPinnedAction(nodeSetup?.uses, "actions/setup-node", label);
          expectPinnedVersion(filename, "actions/setup-node", "v5");
          const selected = String(nodeSetup?.with?.["node-version"]);
          expect(
            ["22", "24", "${{ matrix.node-version }}"],
            `${label} must select a supported Node (22 floor, 24 current, or the smoke matrix)`,
          ).toContain(selected);
          expect(nodeSetup?.if, `${label} must not conditionally select Node`).toBeUndefined();
        }
      }
    }

    expect(coveredInstallJobs.sort()).toEqual([
      "akm-eval-smoke.yml#determinism",
      "ci.yml#check",
      "ci.yml#node-smoke",
      "ci.yml#upgrade-rehearsal",
      "gated-ci.yml#docker-install",
      "gated-ci.yml#native-scheduler",
      "gated-ci.yml#semantic-search",
      "release.yml#release",
    ]);
  });
});
