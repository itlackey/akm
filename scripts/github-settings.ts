// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Applies the repository settings that enforce the release process (docs/maintainers/release-checklist.md,
 * "Repository settings") through `gh api`:
 *
 *   - ruleset `main`: pull request required (merge commits only), every check a release pull request reports
 *     required with the branch up to date, no force pushes, no deletion, no bypass;
 *   - ruleset `release/*`: no force pushes;
 *   - merged branches are deleted; merge commits are allowed;
 *   - environment `release` deploys from `main` and `release/*` only;
 *   - the release branches left over from the old process are deleted.
 *
 * The required checks are read from .github/workflows/ci.yml and gated-ci.yml (every job and matrix entry CI runs
 * on a release pull request), so the script is rerun after a matrix change and the ruleset follows. Idempotent.
 * Needs `gh` logged in with admin rights on the repository.
 *
 *   bun scripts/github-settings.ts            # apply
 *   bun scripts/github-settings.ts --dry-run  # print the requests instead
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import YAML from "yaml";

const dryRun = process.argv.includes("--dry-run");
const STALE_BRANCHES = ["release/0.9.25", "release/0.9.26", "release/0.9.27", "release/0.10.261020"];

type Job = {
  name?: string;
  uses?: string;
  strategy?: { matrix?: Record<string, unknown> };
};
type Workflow = { jobs: Record<string, Job> };

/** The check names GitHub reports for a workflow's jobs: `name` or the job id, one per matrix entry. */
function checkNames(workflow: Workflow, prefix = ""): string[] {
  const names: string[] = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (job.uses) continue;
    const matrix = job.strategy?.matrix;
    if (!matrix) {
      names.push(prefix + (job.name ?? id));
      continue;
    }
    // One-dimensional matrices, as this repository's are: `include` entries, or one key with a list of values.
    const entries: Record<string, unknown>[] = Array.isArray(matrix.include)
      ? (matrix.include as Record<string, unknown>[])
      : (Object.values(matrix)[0] as unknown[]).map((value) => ({ [Object.keys(matrix)[0] as string]: value }));
    for (const entry of entries) {
      const name = job.name
        ? job.name.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key: string) => String(entry[key]))
        : `${id} (${Object.values(entry).join(", ")})`;
      names.push(prefix + name);
    }
  }
  return names;
}

function readWorkflow(file: string): Workflow {
  return YAML.parse(fs.readFileSync(`.github/workflows/${file}`, "utf8")) as Workflow;
}

function api<T = unknown>(method: string, path: string, body?: unknown): T | null {
  if (dryRun && method !== "GET") {
    console.log(`${method} ${path}${body ? `\n${JSON.stringify(body, null, 2)}` : ""}`);
    return null;
  }
  const args = ["api", "-X", method, "-H", "X-GitHub-Api-Version: 2022-11-28", path];
  if (body) args.push("--input", "-");
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      input: body ? JSON.stringify(body) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim() === "" ? null : (JSON.parse(out) as T);
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (method === "GET" && /HTTP 404/.test(stderr)) return null;
    throw new Error(`gh api ${method} ${path} failed: ${stderr.trim()}`);
  }
}

function upsertRuleset(repo: string, ruleset: { name: string } & Record<string, unknown>): void {
  const existing = api<Array<{ id: number; name: string }>>("GET", `/repos/${repo}/rulesets`) ?? [];
  const found = existing.find((r) => r.name === ruleset.name);
  if (found) {
    api("PUT", `/repos/${repo}/rulesets/${found.id}`, ruleset);
    console.log(`ruleset ${ruleset.name}: updated`);
  } else {
    api("POST", `/repos/${repo}/rulesets`, ruleset);
    console.log(`ruleset ${ruleset.name}: created`);
  }
}

function main(): void {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
  if (!repo) throw new Error(`origin is not a GitHub repository: ${remote}`);
  const checks = [...checkNames(readWorkflow("ci.yml")), ...checkNames(readWorkflow("gated-ci.yml"), "gated / ")];
  console.log(`${repo}: ${checks.length} required checks on main:\n  ${checks.join("\n  ")}`);

  upsertRuleset(repo, {
    name: "main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["merge"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: checks.map((context) => ({ context })),
        },
      },
    ],
  });

  upsertRuleset(repo, {
    name: "release branches",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/release/*"], exclude: [] } },
    rules: [{ type: "non_fast_forward" }],
  });

  api("PATCH", `/repos/${repo}`, { delete_branch_on_merge: true, allow_merge_commit: true });
  console.log("repository: merged branches are deleted; merge commits allowed");

  // The environment keeps its reviewers and wait timer; only the deployment branches change.
  type Environment = {
    protection_rules?: Array<{
      type: string;
      wait_timer?: number;
      prevent_self_review?: boolean;
      reviewers?: Array<{ type: string; reviewer: { id: number } }>;
    }>;
  };
  const environment = api<Environment>("GET", `/repos/${repo}/environments/release`);
  const rules = environment?.protection_rules ?? [];
  const reviewerRule = rules.find((rule) => rule.type === "required_reviewers");
  api("PUT", `/repos/${repo}/environments/release`, {
    wait_timer: rules.find((rule) => rule.type === "wait_timer")?.wait_timer ?? 0,
    prevent_self_review: reviewerRule?.prevent_self_review ?? false,
    reviewers: (reviewerRule?.reviewers ?? []).map((r) => ({ type: r.type, id: r.reviewer.id })),
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
  const policies =
    api<{ branch_policies: Array<{ name: string }> }>(
      "GET",
      `/repos/${repo}/environments/release/deployment-branch-policies`,
    )?.branch_policies.map((policy) => policy.name) ?? [];
  for (const name of ["main", "release/*"]) {
    if (!policies.includes(name)) {
      api("POST", `/repos/${repo}/environments/release/deployment-branch-policies`, { name, type: "branch" });
    }
  }
  console.log("environment release: deploys from main and release/* only");

  for (const branch of STALE_BRANCHES) {
    if (api("GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`)) {
      api("DELETE", `/repos/${repo}/git/refs/heads/${branch}`);
      console.log(`deleted ${branch}`);
    }
  }
}

main();
