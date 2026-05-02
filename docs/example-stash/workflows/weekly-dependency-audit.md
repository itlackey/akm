---
description: Run a focused weekly dependency audit — surface outdated and vulnerable packages, classify them by upgrade risk, land safe upgrades behind tests, and queue the rest for review without bundling unrelated work into one giant PR.
tags:
  - example
  - maintenance
  - dependencies
  - vault
  - weekly
params:
  package_manager: "Package manager in use (`bun`, `pnpm`, `npm`, `yarn`, or `cargo`). Defaults to `bun`."
  base_branch: "Branch to cut the audit branch from. Defaults to `main`."
  vault: "Optional vault ref with private-registry credentials (e.g. `vault:npm-readonly`). Loaded only at the shell level, never echoed."
  workspace_dir: "Directory for run artefacts. Defaults to `.akm-run/{{ runId }}`."
  max_pr_size: "Soft cap on the number of packages bundled into a single PR. Defaults to `8`."
  freeze_list: "Optional JSON array of package names that must not be upgraded this week (e.g. `[\"react\", \"vite\"]`)."
---

# Workflow: Weekly Dependency Audit

A short, repeatable workflow for the recurring "is anything dangerous in our
lockfile this week?" question. Run it on a schedule, hand the output to
review, move on. Optimised for *not* drifting into a half-finished migration
or accidentally importing a sketchy postinstall script.

## Step: Prepare a clean audit branch
Step ID: prepare-branch

### Instructions
Set up an isolated workspace before touching the lockfile.

1. Confirm `base_branch` is up to date:

   ```sh
   git fetch origin {{ base_branch }}
   git switch -c chore/dep-audit-{{ runId }} origin/{{ base_branch }}
   ```

2. If `vault` is provided, verify the keys it declares without surfacing
   values:

   ```sh
   akm vault show {{ vault }}
   ```

   Block the run if any key the registry needs is missing.
3. Create `{{ workspace_dir }}/audit-context.md` with the run timestamp,
   `package_manager`, `base_branch` HEAD SHA, and the contents of
   `freeze_list` (if any).

### Completion Criteria
- A clean branch `chore/dep-audit-{{ runId }}` exists from a fresh
  `base_branch`.
- `vault` keys are confirmed present (or `vault` was omitted intentionally).
- `audit-context.md` records the starting state for reproducibility.

## Step: Inventory outdated and vulnerable packages
Step ID: inventory

### Instructions
Produce one canonical list of candidates. Do not start upgrading yet.

1. Load registry credentials only into the shell that runs the audit
   commands, never into agent context:

   ```sh
   source <(akm vault load {{ vault }})
   ```

2. Run the package-manager-native commands and capture full output to disk:

   - `bun`: `bun outdated --json` and `bun audit --json`
   - `pnpm`: `pnpm outdated --json` and `pnpm audit --json`
   - `npm`: `npm outdated --json` and `npm audit --json`
   - `yarn`: `yarn outdated --json` and `yarn npm audit --json`

   Save raw output to `{{ workspace_dir }}/outdated.json` and
   `{{ workspace_dir }}/audit.json`.
3. Build `{{ workspace_dir }}/candidates.md` with one row per package:
   `name`, `current`, `wanted`, `latest`, `severity` (from audit, if any),
   `direct_dep` (yes/no), `notes`. Strip out anything in `freeze_list`.

### Completion Criteria
- `outdated.json` and `audit.json` exist with raw tool output.
- `candidates.md` lists every upgrade candidate with version deltas and
  severity.
- Packages in `freeze_list` are excluded from `candidates.md` and the reason
  is recorded.

## Step: Classify by upgrade risk
Step ID: classify

### Instructions
Sort candidates into bands so that the safe ones can ship today and the rest
can be triaged separately.

For each row in `candidates.md`, assign one of:

- **green** — patch bumps, lockfile-only changes, dev-only tools with
  passing tests, or transitive deps with no API surface change.
- **yellow** — minor bumps, anything that touches a build pipeline, or
  packages with a non-trivial changelog.
- **red** — major bumps, anything in audit with `high` or `critical`
  severity, packages whose changelog mentions breaking changes or runtime
  behaviour changes, and anything with fewer than two weeks since release.

Write `{{ workspace_dir }}/classified.md` with three sections (`green`,
`yellow`, `red`) and a one-line justification per package. If a package's
changelog cannot be located, default it to `yellow` and record the gap.

### Completion Criteria
- Every candidate has exactly one band assigned.
- Each classification has a one-line justification (changelog, severity, age).
- Packages with missing changelog provenance are not silently promoted to
  `green`.

## Step: Land the green band
Step ID: land-green

### Instructions
Apply the safe upgrades and prove they did not regress.

1. Apply only the green-band upgrades. Stay under `max_pr_size`; if there
   are more, split into multiple PRs by domain (testing tools, types,
   runtime, etc.).
2. Run the project's verification gates and save outputs:

   ```sh
   bunx biome check --write src/ tests/
   bunx tsc --noEmit
   bun test
   ```

3. Commit with the convention `chore(deps): bump <list>` and push the
   branch. Open a PR titled `chore(deps): weekly green-band audit
   {{ runId }}` whose body links to `classified.md` and lists every package
   bumped with `current → new`.
4. If any gate fails, do not push a partially working batch. Bisect the
   failing package, demote it from `green` to `yellow` with a note, and
   retry.

### Completion Criteria
- A PR exists for the green band, gates passing, body linking to
  `classified.md`.
- No green-band package is shipped without a clean lint, typecheck, and
  test run.
- Demotions from green to yellow are recorded with the failing evidence.

## Step: Queue yellow and red for review
Step ID: queue-review

### Instructions
The point of this workflow is to *not* try to land the hard cases on a
schedule. Hand them off cleanly instead.

1. For each yellow-band package, file a follow-up issue with:
   - the version delta and changelog link
   - the test surfaces likely to be affected
   - a one-paragraph upgrade plan
2. For each red-band package, file an issue tagged `dep-upgrade` and
   `needs-design` linking to the changelog and to any audit advisory. Do
   *not* attempt the upgrade in this run.
3. Update `{{ workspace_dir }}/handoff.md` listing every issue filed, the
   green-band PR link, and any package that was deferred without an issue
   (with reason).

### Completion Criteria
- Every yellow and red package is either in a filed issue or explicitly
  deferred with a reason in `handoff.md`.
- The green-band PR is linked from `handoff.md`.
- No "I'll do it next week" items are left in the workflow run notes
  without a corresponding tracked issue.
