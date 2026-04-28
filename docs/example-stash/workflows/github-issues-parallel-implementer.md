---
description: Drive a batch of GitHub issues to merged PRs using a multi-agent development, review, and testing loop on isolated git worktrees.
tags:
  - example
  - github
  - multi-agent
  - parallel
  - worktrees
params:
  repo: "Target repository in `owner/name` form (e.g. `itlackey/akm`)."
  issues: "JSON array of GitHub issue numbers to implement (e.g. `[142, 167, 171]`). The workflow will order and batch them."
  base_branch: "Branch to cut feature branches from and ultimately open PRs against. Defaults to `main` when omitted."
  integration_branch: "Optional long-lived branch name used when multiple issues must be delivered together. When omitted, each issue ships as its own PR."
  max_parallel: "Maximum number of issues the implement step may run in parallel. Defaults to `3` — tune to the host's CPU/memory budget."
  reviewers: "JSON array of reviewer agent roles required to approve each issue (e.g. `[\"senior-engineer\", \"security\", \"domain-expert\"]`). All listed reviewers must approve."
  required_checks: "JSON array of required status checks (e.g. `[\"lint\", \"typecheck\", \"unit\", \"integration\", \"e2e\"]`). All must pass before an issue is marked complete."
  vault: "Optional `vault:` ref with credentials needed for CI, deploy previews, or private package registries. Loaded only at the shell level via `akm vault load`."
---

# Workflow: GitHub Issues Parallel Implementer

## Step: Intake and Validate
Step ID: intake

### Instructions

You are the **orchestrator agent** for this run. Before doing any coding work, establish a clean baseline and confirm every parameter is actionable.

#### Verify parameters
1. Parse `issues` as JSON. Abort the run with `--state blocked` if it is not a non-empty array of positive integers.
2. Confirm `repo` is reachable via `gh repo view {{ repo }}`. If the CLI is unauthenticated, surface the error verbatim and block the run — do not attempt to log in silently.
3. Resolve `base_branch` (default `main`) and confirm it exists on the remote with `git ls-remote --heads origin {{ base_branch }}`.
4. If `vault` is provided, call `akm vault show {{ vault }}` and verify every key the downstream tooling needs is declared. Do not print values. If any key is missing, block the run with notes listing the missing keys.

#### Capture ground truth for every issue
For each issue number in `issues`:

- Fetch the full issue body, labels, assignees, and linked PRs via `gh issue view <n> --json number,title,body,labels,assignees,comments,closedByPullRequestsReferences`.
- Record the payload in the run notes so later steps can replay context without another API round-trip.
- Flag issues that are already `closed`, have a merged linked PR, or are marked `blocked` / `needs-triage`. These are removed from the working set and reported back to the user before planning.

#### Prepare a shared workspace
- Create a scratch directory under `.akm-run/{{ runId }}/` (outside of any existing worktree). Store issue payloads, plan artefacts, and per-issue logs here.
- Ensure the repo has no uncommitted changes on the current branch. If it does, abort with a `blocked` state — never stash or discard user work.
- Fetch the latest `base_branch` with `git fetch origin {{ base_branch }}` so subsequent worktrees branch from fresh commits.

#### Hand-off contract
The next step can assume:

- Every issue in the working set has a cached payload on disk.
- `base_branch` is up to date locally.
- Required secrets are declared (but not loaded into the agent context).

### Completion Criteria
- `issues` parsed to a non-empty list of open, actionable GitHub issues.
- `repo`, `base_branch`, and (if provided) `vault` all pass their health checks.
- Working set, scratch directory, and cached issue payloads are recorded in the run notes.
- Any excluded issues are listed with the reason they were dropped.

## Step: Plan and Order
Step ID: plan-and-order

### Instructions

Produce a dependency-aware execution plan. This step runs **exclusively in planning mode** — no code changes, no branches, no worktrees.

#### Dispatch the planner agent
Launch one planner agent with the cached issue payloads plus the current codebase index. Instruct it to:

1. Read each issue and classify it by **type** (bug, feature, refactor, docs, infra) and **blast radius** (single-file, module, cross-cutting).
2. Identify **hard dependencies** — issue B explicitly says "after #A", a shared schema change, a migration that must land first. Represent these as a directed acyclic graph. Abort with `blocked` if a cycle is found and surface the cycle in notes.
3. Identify **soft conflicts** — two issues that touch overlapping files, tests, or public APIs. These may still run in parallel but must be flagged so the integration step can merge in a deterministic order.
4. Produce an ordered list of **batches**. A batch is a set of issues with no hard dependency between members and no high-risk soft conflict. Batch size must not exceed `max_parallel`.
5. For each issue, draft a short **implementation brief**: acceptance criteria pulled from the issue body, files likely to change, test surfaces that must be exercised, and any risk callouts (perf, security, data migration).

#### Validate the plan with a second agent
Spawn an independent **plan reviewer agent** with no memory of the planner's reasoning. Give it only the issue payloads and the planner's output. Ask it to:

- Challenge every dependency edge — is it real, or could the issues run in parallel?
- Challenge every parallel grouping — is there a hidden conflict the planner missed (shared migrations, shared feature flags, shared API contracts)?
- Confirm each brief's acceptance criteria are testable. Reject vague criteria like "it should feel faster".

Iterate until the reviewer signs off or escalate to the user when the two agents cannot converge within three rounds.

#### Persist the plan
Write the final plan to `.akm-run/{{ runId }}/plan.json` with this shape:

- `batches`: ordered array; each batch is an array of issue numbers.
- `briefs`: map of issue number to `{ acceptance, files, tests, risks }`.
- `soft_conflicts`: list of `[issueA, issueB, reason]` tuples for the integration step.

Record the batch count, total issue count, and any escalations in the run notes so an interrupted run can resume from this artefact alone.

### Completion Criteria
- A plan.json artefact exists with batches, briefs, and soft-conflict annotations.
- The plan has been independently reviewed by a second agent and signed off.
- No dependency cycles remain; every dropped or re-ordered issue has a reason recorded.
- At least one testable acceptance criterion per issue.

## Step: Prepare Worktrees
Step ID: prepare-worktrees

### Instructions

Create one git worktree per issue in the current batch so implementation agents are fully isolated.

#### For every issue in the current batch
1. Derive a branch name from the issue: `agents/{{ runId }}/issue-<n>-<slug>` where `<slug>` is a kebab-cased, length-capped form of the issue title.
2. Create the worktree: `git worktree add .akm-run/{{ runId }}/wt/<n> -b <branch> origin/{{ base_branch }}`.
3. Seed the worktree with any run-scoped context files it needs (the brief, the acceptance criteria, the relevant test commands). Do not copy secrets.
4. Inside the worktree, run the project bootstrap: install dependencies, run a baseline build, and run the full test suite once. Record the baseline results (pass/fail counts, duration) so regressions introduced by the implementer are unambiguous.

#### Failure handling
- If bootstrap or the baseline test run fails on an untouched worktree, the issue is marked `blocked` with the failing output in notes. The workflow does not pretend a broken baseline is acceptable.
- If a worktree already exists from a previous run, reuse it only after running `git worktree prune` and confirming the branch head matches the expected commit. Otherwise remove and re-create it.

### Completion Criteria
- Every issue in the current batch has a dedicated worktree on a fresh branch from `base_branch`.
- A green baseline build and test run is recorded for each worktree.
- Any issue that failed bootstrap is explicitly marked `blocked` with a diagnostic excerpt.

## Step: Implement, Review, and Test Loop
Step ID: implement-review-test

### Instructions

For each issue in the current batch, drive a closed loop between **implementer**, **reviewer(s)**, and **tester** agents until the issue is either accepted or escalated. Issues in a batch run concurrently up to `max_parallel`; the loop itself is per-issue.

#### Roles
- **Implementer**: owns the code changes for one issue inside its worktree. May consult skills, run tooling, and inspect the codebase, but never bypasses tests or linters.
- **Reviewers**: one agent per role listed in `reviewers`. Each reviewer reads only the diff, the brief, and the test output — not the implementer's reasoning. Reviewers vote independently.
- **Tester**: runs the `required_checks` suite, reports raw results, and never fixes failures themselves. The tester is the source of truth for whether checks pass.
- **Loop captain**: a lightweight orchestrator agent that routes between the above, tracks iteration count, and enforces termination.

#### Iteration protocol
Each round proceeds in this order. Do not skip steps even when a round feels trivial.

1. **Implement**: the implementer applies focused changes mapped to the brief's acceptance criteria. Diffs must stay on-topic — drive-by refactors are rejected by the reviewer unless the brief asks for them.
2. **Self-check**: the implementer runs lint, typecheck, and the fast test subset locally before requesting review. If any fail, iterate before handing off.
3. **Test**: the tester runs every command in `required_checks`, captures the full output to `.akm-run/{{ runId }}/logs/<n>/round-<k>.log`, and returns a structured pass/fail map. Flaky tests are re-run once and annotated.
4. **Review**: each reviewer agent renders an independent verdict of `approve`, `request_changes`, or `block`. Reviewers cite file paths and line numbers. Reviews are posted as structured comments on the worktree branch for auditability.
5. **Adjudicate**: the loop captain merges the verdicts. The round passes only when **all** reviewers approve **and** every required check is green. Any `block` verdict halts the loop and escalates.
6. **Next round**: if the round did not pass, the implementer receives the union of reviewer comments plus tester failures, addresses them, and the cycle repeats.

#### Termination and escalation
- The loop has a hard ceiling of **eight rounds** per issue. On round nine the issue is marked `blocked` with the last round's artefacts and escalated to the user.
- If two consecutive rounds produce no diff reduction in reviewer comments, the loop captain must request human input — progress has stalled and more rounds will not help.
- If a reviewer posts `block` (as opposed to `request_changes`), the issue goes to `blocked` immediately; a `block` verdict means the approach itself is wrong and more iteration will not fix it.

#### Quality gates that must be enforced every round
- No test is skipped, `.only`-focused, or commented out to make the suite pass.
- Public API changes include updated type definitions and documentation in the same diff.
- Any new dependency requires an explicit note in the PR description explaining why an existing one did not suffice.
- Security-sensitive diffs (auth, crypto, shell invocation, SQL, deserialization) require the `security` reviewer to approve explicitly even when not listed by default.
- Performance-sensitive paths include a before/after measurement captured by the tester.

#### Loop done definition
An issue exits this step only when the final round satisfies all of:

- Every reviewer in `reviewers` returned `approve`.
- Every check in `required_checks` is green against the head commit of the issue's branch.
- The diff is focused on the brief — unrelated files are reverted.
- A short implementer summary, the reviewer verdicts, and the tester log are written to `.akm-run/{{ runId }}/summaries/<n>.md`.

#### Batch progression
When every issue in the current batch has exited the loop (accepted or escalated), advance to the next batch from `plan.json`. Re-enter this step at the top — it is intentionally re-runnable until the batch list is empty. Keep this step in `in_progress` across batches; only mark it `completed` when the last batch is done.

### Completion Criteria
- Every issue in `plan.json` has either an accepted summary or an explicit `blocked` escalation.
- No accepted issue has skipped, focused, or disabled tests in its diff.
- Per-issue summary files exist under `.akm-run/{{ runId }}/summaries/` with reviewer verdicts and tester logs referenced.
- No batch advanced past one with unresolved escalations without explicit user acknowledgement.

## Step: Integrate and Reconcile
Step ID: integrate

### Instructions

Accepted issue branches may still conflict when combined. This step merges them in a controlled order and re-validates the combined result.

#### Determine integration mode
- If `integration_branch` is empty, skip merging — each accepted issue will ship its own PR in the next step. Jump to the completion criteria.
- If `integration_branch` is set, create it from `base_branch` and fast-forward or merge each accepted issue branch in the order defined by `plan.json`, honouring `soft_conflicts`.

#### Merge procedure for the integration branch
1. Check out the integration branch in a dedicated worktree.
2. For each accepted issue, in plan order:
   - Merge with `git merge --no-ff` to preserve per-issue history.
   - Run the full `required_checks` suite after each merge. A failure triggers a rollback of just that merge (`git reset --hard HEAD~1`), an entry in notes, and the issue is sent back through the implement/review/test loop with a conflict-aware brief.
3. After all merges land, run the test suite one more time from a clean install to catch caching or lockfile drift.
4. Generate a combined diff summary and feed it to one **integration reviewer** agent. Its only job is to catch semantic conflicts that per-issue reviews could not see — overlapping feature flags, duplicated utilities, inconsistent logging, redundant migrations.

#### Hygiene
- Update lockfiles and regenerated artefacts in a single dedicated commit so the PR remains reviewable.
- If any accepted issue must be reverted to stabilise the integration branch, mark that issue `blocked` and reopen it in the next run — never silently drop work.

### Completion Criteria
- Integration branch exists, builds cleanly, and passes every `required_checks` entry from a clean install.
- Integration reviewer has approved the combined diff or escalated with specific file references.
- Any reverted issue is explicitly marked `blocked` with a new brief for a follow-up run.
- Skipped entirely when `integration_branch` is empty (and this fact is recorded in notes).

## Step: Push and Open Pull Requests
Step ID: open-prs

### Instructions

Turn the accepted branches into pull requests that a human reviewer can approve without reconstructing the run.

#### For each PR to open
1. Push the branch with `git push -u origin <branch>`. Retry network errors up to four times with exponential backoff (2s, 4s, 8s, 16s). Do not use `--force` or `--no-verify`.
2. Open the PR against `base_branch` with `gh pr create`. The title must reference the issue (`Fixes #<n>: <short title>`). The body must include:
   - A one-paragraph summary of the change.
   - The acceptance criteria from the brief, each with a check mark and a one-line proof (commit sha, test name, or screenshot path).
   - The reviewer verdicts from the implement step with agent role and timestamp.
   - The full `required_checks` result matrix for the head commit.
   - Links to the run notes and per-issue summary.
3. Request the human reviewers configured on the repo (CODEOWNERS, default reviewers, or the users specified in the issue). Do not request AI agents as GitHub reviewers — agent approval is captured in the body.
4. Apply the labels the planner recommended (e.g. `type:bug`, `area:cli`, `risk:low`). Never add a `ready-to-merge` or equivalent label — that is a human decision.

#### If using an integration branch
Open a single PR for `integration_branch -> base_branch`. Its body must enumerate every included issue, link each issue's individual summary file, and preserve the per-issue reviewer verdicts.

#### Verify the PR
- Confirm the PR number, URL, and head sha are recorded in the run notes.
- Trigger CI with a comment (`gh pr comment <n> --body "/ci run"` or the repo's convention) only if CI does not fire automatically on push.
- If a PR cannot be opened (permission denied, branch protection violation), mark the step `blocked` with the error and do not retry silently.

### Completion Criteria
- Every accepted issue has an open PR with the required body sections populated.
- Every PR references its issue via `Fixes #<n>` (or the repo's equivalent keyword).
- PR numbers, URLs, and head shas are captured in the run notes.
- No PR was force-pushed or opened with verification skipped.

## Step: Watch CI and Address Review Feedback
Step ID: watch-and-respond

### Instructions

PRs are not done when they are opened; they are done when they merge or are explicitly closed. This step is long-running and intentionally re-enterable.

#### CI watch
- Poll PR checks via `gh pr checks <n>` until every required check settles. Do not sleep-poll from the agent loop — use the CI provider's webhook/subscription when available and fall back to timed polling with exponential backoff.
- On a red check, fetch the failing job logs, produce a minimal reproduction, and hand the issue back to the implement/review/test loop with a `ci-regression` brief. Do not patch the red check in isolation — the full loop must run again so the fix is reviewed and re-tested.

#### Review feedback
- When a human reviewer leaves comments, route each comment to the implementer for response. Each response must either:
  - Update the code and the PR with a follow-up commit, or
  - Reply explaining why the suggestion does not apply, citing the brief, a constraint, or a measurement.
- Never resolve a review thread on behalf of the human reviewer — only the reviewer or the repo maintainer resolves their own threads.

#### Merge readiness
An agent may request merge when:

- All required checks are green on the latest head sha.
- All human reviewers have approved or explicitly deferred.
- No unresolved blocking comments remain.
- The PR branch is up to date with `base_branch` — if not, rebase (or merge, per repo convention) and re-run CI before requesting merge.

Actual merging is a human decision unless the user has previously authorised auto-merge for this workflow; in that case use `gh pr merge --auto --squash` (or the repo's convention) and record the request in notes.

### Completion Criteria
- Every PR is in one of these terminal states: merged, closed with reason, or handed off to a named human owner with an explicit note.
- Every CI regression triggered a full re-run of the implement/review/test loop, not a bypass.
- Every human review comment has either a follow-up commit or a written response — none are silently ignored.

## Step: Archive and Clean Up
Step ID: archive

### Instructions

Leave the environment in the state a fresh run would expect to find it.

#### Artefacts
- Move `.akm-run/{{ runId }}/` to a long-term location (e.g. `.akm-archive/` inside the stash, or an external artefact store configured by the user). Keep the plan.json, per-issue summaries, and final PR metadata — they are the audit trail for the run.
- Redact any accidentally captured secrets from logs before archiving. Use the keys declared in `vault` as a denylist during redaction.

#### Worktrees and branches
- For every worktree under `.akm-run/{{ runId }}/wt/`, run `git worktree remove` after confirming the branch is either merged or explicitly preserved.
- Never delete a branch that has unmerged commits unless the user has approved it in this run.
- Prune stale worktree metadata with `git worktree prune` and leave the main checkout on its original branch.

#### Run summary
Emit a final summary to the user covering:

- Count of issues processed, accepted, blocked, and deferred.
- Links to every PR with its merge state.
- Wall-clock duration per step and the total number of implement/review/test rounds consumed.
- Any escalations that still need a human decision, grouped so they can be handed off in a single message.

### Completion Criteria
- Run artefacts archived or deliberately discarded with the user's acknowledgement.
- All temporary worktrees removed; no orphaned branches left on the local repo or remote.
- Final summary delivered to the user with explicit pointers to every PR and every outstanding escalation.
