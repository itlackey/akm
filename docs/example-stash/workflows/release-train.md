---
description: Drive a recurring release from a quiet base branch to a tagged, deployed, retrospected release. Composes other workflows as nested runs — `weekly-dependency-audit`, `code-review-pr` (per release-blocker PR), and a final retrospective — so the orchestrator stays small and the heavy lifting lives in dedicated, individually testable workflows.
tags:
  - example
  - release
  - nested-workflows
  - orchestration
  - vault
params:
  release_version: "Semver version being released (e.g. `1.4.0`). The workflow validates this against the changelog and tags."
  base_branch: "Branch the release is cut from. Defaults to `main`."
  release_branch: "Optional release branch (e.g. `release/1.4.x`). Defaults to `release/{{ release_version }}` when omitted."
  release_pr_query: "GitHub search query that selects the PRs in scope for this release (e.g. `is:open milestone:1.4.0 label:release-blocker`). The orchestrator iterates this list."
  deploy_vault: "Vault ref with deploy credentials (e.g. `vault:production`). Loaded only at the shell level, never echoed."
  workspace_dir: "Directory for run artefacts. Defaults to `.akm-run/{{ runId }}`."
  knowledge_wiki: "AKM wiki for release notes and retrospectives. Defaults to `engineering`."
  skip_dependency_audit: "Set to `true` to skip the nested dependency audit (e.g. for hotfixes). Defaults to `false`."
---

# Workflow: Release Train

This workflow is an **orchestrator**. It does very little real work itself.
Each major phase delegates to a *nested run* of another workflow in this
stash:

- pre-flight maintenance → `workflow:weekly-dependency-audit`
- per-PR sign-off → one `workflow:code-review-pr` run per blocker
- post-release learning → `workflow:release-retrospective` (defined inline
  below as a sibling workflow you can split out)

The pattern is intentional. Each nested workflow is *individually*
runnable, testable, and resumable. The orchestrator's only job is to
sequence them, stitch their outputs together, and own the cross-cutting
release artefacts (changelog, tag, deploy, announcement). Because every
nested run gets its own `runId`, an interrupted release can resume by
asking `akm workflow status` of the orchestrator and walking down to the
nested runs it spawned.

## Step: Open the release book
Step ID: open-release-book

### Instructions
Establish a single durable index of every artefact this release will
produce, including the IDs of nested runs.

1. Validate `release_version` is semver. Resolve `release_branch` to its
   default if omitted.
2. Create `{{ workspace_dir }}/release-book.md` with these sections, all
   initially empty:
   - `Inputs` — params, base SHA, expected scope from `release_pr_query`.
   - `Nested runs` — IDs of each nested workflow run, with state.
   - `Artefacts` — changelog path, tag, deploy log, announcement.
   - `Anomalies` — anything that needed manual override.
3. Snapshot the current state of `{{ release_pr_query }}`:

   ```sh
   gh pr list --search "{{ release_pr_query }}" \
     --json number,title,author,labels,headRefName,statusCheckRollup \
     > {{ workspace_dir }}/in-scope-prs.json
   ```

   Block the run with a clear message if the list is empty *and*
   `skip_dependency_audit` is `true` — there is nothing to release.

### Completion Criteria
- `release-book.md` exists and is the canonical index for this release.
- `in-scope-prs.json` lists every PR matched by `release_pr_query` at the
  point the release started.
- `release_branch` is resolved and recorded in `release-book.md`.

## Step: Run the dependency audit as a nested workflow
Step ID: nested-dependency-audit

### Instructions
Unless `skip_dependency_audit` is `true`, every release passes through
the same weekly dependency audit before opening the release branch. We
do not duplicate that logic here — we *call* it.

1. If `skip_dependency_audit` is `true`, mark this step
   `--state skipped --notes "hotfix release"` and continue. Otherwise:
2. Start the nested run, passing through the parameters it needs:

   ```sh
   akm workflow start workflow:weekly-dependency-audit \
     --params '{"package_manager":"bun","base_branch":"{{ base_branch }}",
                "freeze_list":[]}'
   ```

   Capture the returned run ID — call it `DEP_RUN_ID` — and append it to
   the `Nested runs` section of `release-book.md`.
3. Drive the nested run to completion exactly as a human would. Each
   call returns the next actionable step:

   ```sh
   akm workflow next $DEP_RUN_ID
   # ... do the work for that step ...
   akm workflow complete $DEP_RUN_ID --step <step-id> --state completed \
     --notes "..." --evidence '{"artefact":"path/to/output"}'
   ```

   Repeat until `akm workflow status $DEP_RUN_ID` reports the run as
   `completed`.
4. Read the nested run's `handoff.md` artefact. If it produced a
   green-band PR, add that PR to `in-scope-prs.json` for this release.
   If it produced any red-band issues, link them in `release-book.md`
   under `Anomalies` so the retrospective can pick them up.
5. If the nested run finishes in `blocked` or `failed`, do not paper
   over it. Block this orchestrator step with the nested run ID in the
   notes — the release does not advance until the dependency audit is
   resolved (which may itself need `akm workflow resume`).

### Completion Criteria
- Either the dep-audit run is in state `completed` and its outputs are
  reflected in this release's book, or this step is `skipped` for a
  hotfix with an explicit note.
- The nested run ID is recorded in `release-book.md` so the audit trail
  is recoverable from the orchestrator alone.
- A failed nested run blocks the orchestrator instead of being silently
  ignored.

## Step: Cut the release branch and lock scope
Step ID: cut-release-branch

### Instructions
With dependencies green, lock the scope of what this release contains.

1. Cut `release_branch` from `base_branch`:

   ```sh
   git fetch origin {{ base_branch }}
   git switch -c {{ release_branch }} origin/{{ base_branch }}
   git push -u origin {{ release_branch }}
   ```

2. Re-run the PR query and diff it against `in-scope-prs.json`. New PRs
   matching the query after the release started are *not* automatically
   included — append them to `Anomalies` in `release-book.md` and require
   an explicit decision before adding them to scope.
3. Generate a changelog draft at `{{ workspace_dir }}/CHANGELOG.draft.md`
   using PR titles, labels, and bodies from `in-scope-prs.json`. Group
   into `Features`, `Fixes`, `Internal`, `Breaking`. Mark anything
   `Breaking` for explicit reviewer attention in the next step.

### Completion Criteria
- `release_branch` exists on the remote and is based on a known
  `base_branch` SHA recorded in `release-book.md`.
- `CHANGELOG.draft.md` covers every PR in `in-scope-prs.json`, grouped
  and with `Breaking` items flagged.
- Late-arriving PRs are surfaced in `Anomalies`, never silently merged.

## Step: Review every release-blocker PR as a nested workflow
Step ID: nested-pr-reviews

### Instructions
For each PR in `in-scope-prs.json` that is not already approved by a
human reviewer, drive it through the standard review workflow as a
nested run. The orchestrator tracks the per-PR run IDs and aggregates
the verdicts.

1. Build a worklist file `{{ workspace_dir }}/review-worklist.md` from
   `in-scope-prs.json`. For each PR, record `pr_ref`, current review
   state, and the nested run ID once started.
2. For each unreviewed PR (process up to 3 in parallel — see the
   `github-issues-parallel-implementer.md` example for the worktree
   pattern):

   ```sh
   akm workflow start workflow:code-review-pr \
     --params '{"pr_ref":"gh:itlackey/akm#<num>","conventions_query":"<title>",
                "knowledge_wiki":"{{ knowledge_wiki }}"}'
   ```

   Append the returned run ID to the worklist, then drive it via
   `akm workflow next` / `akm workflow complete` until the nested run
   reports `completed`.
3. After each nested run finishes, re-read its
   `rubric.md` artefact:
   - If every rubric item is `pass` or `concern`, mark the PR
     reviewed in the worklist.
   - If any rubric item is `block`, the PR is *not* releasable. Either
     wait for a fix and re-run the nested workflow on the new commit,
     or remove the PR from scope and update `Anomalies`.
4. When all PRs in the worklist are either reviewed-and-merged or
   removed-from-scope, regenerate `CHANGELOG.draft.md` against the
   actual merged set and promote it to `CHANGELOG.md` on the release
   branch.

### Completion Criteria
- Every in-scope PR has a corresponding nested `code-review-pr` run ID
  in `review-worklist.md`, or a recorded reason it was excluded.
- No PR with a `block` rubric verdict is in the merged release set.
- `CHANGELOG.md` on the release branch matches the actual merged PRs,
  not the original projection.

## Step: Tag, deploy, and announce
Step ID: tag-deploy-announce

### Instructions
The orchestrator owns these cross-cutting steps directly — they are not
themselves multi-step procedures and do not need a nested workflow.

1. Verify all CI on `release_branch` is green:

   ```sh
   gh pr checks {{ release_branch }}
   ```

2. Tag and push:

   ```sh
   git tag -a v{{ release_version }} -m "Release {{ release_version }}"
   git push origin v{{ release_version }}
   ```

3. Load deploy credentials only into the deploy shell:

   ```sh
   source <(akm vault load {{ deploy_vault }})
   ./scripts/deploy.sh {{ release_version }} | tee {{ workspace_dir }}/deploy.log
   ```

   Verify the deploy health check passes before continuing. If it
   fails, mark this step `--state failed` and let the retrospective run
   pick up the incident — do not attempt to clean up the partial deploy
   here.
4. Post the release announcement using `CHANGELOG.md` as the body. Link
   to the orchestrator run ID and to each nested run ID so reviewers can
   audit the path the release took.

### Completion Criteria
- `v{{ release_version }}` tag exists on the remote and points at the
  release branch's tip SHA.
- `deploy.log` shows a successful deploy and a passing health check.
- The announcement links to the orchestrator's run ID for full audit
  traceability.

## Step: Run the retrospective as a nested workflow
Step ID: nested-retrospective

### Instructions
Every release ends with a small retrospective so the *next* release
inherits this one's lessons. We delegate to a focused workflow rather
than burying the retro inside the orchestrator.

1. Start the nested retrospective run:

   ```sh
   akm workflow start workflow:release-retrospective \
     --params '{"release_version":"{{ release_version }}",
                "orchestrator_run_id":"{{ runId }}",
                "knowledge_wiki":"{{ knowledge_wiki }}"}'
   ```

   Append the run ID to `release-book.md` under `Nested runs`.
2. Drive the nested run to completion. Its responsibilities (defined in
   that workflow, not here) are:
   - read `release-book.md` and every nested run's notes
   - extract patterns: which steps blocked, which `Anomalies` recurred
     across releases, which nested workflows themselves need updates
   - publish a retrospective page under
     `wiki:{{ knowledge_wiki }}/releases/{{ release_version }}.md`
   - file follow-up issues for each actionable lesson
3. When the retro finishes, link its wiki page from `release-book.md`
   under `Artefacts`.

If `workflow:release-retrospective` does not yet exist in the stash,
this step blocks with a note pointing the next agent to create it —
that creation work is itself a small `ship-feature-from-spec` run, and
recording the gap in the run is more valuable than papering it over with
ad-hoc notes here.

### Completion Criteria
- A nested retro run is started, completed, and its run ID is recorded.
- A retrospective wiki page exists at
  `wiki:{{ knowledge_wiki }}/releases/{{ release_version }}.md` and is
  linked from `release-book.md`.
- Every actionable lesson is filed as a tracked issue, not left as a
  bullet in the wiki page.

## Step: Close the release book
Step ID: close-release-book

### Instructions
Make the orchestrator's audit trail self-contained.

1. Update `release-book.md` so every section has a real value:
   `Inputs`, `Nested runs` (with each ID and final state), `Artefacts`
   (changelog, tag, deploy log, retro), `Anomalies`.
2. Save the orchestrator's `runId` and the release version as a memory
   so future releases can pattern-match:

   ```sh
   akm remember "Release {{ release_version }} ran via orchestrator
   run {{ runId }}; deploy succeeded on first attempt; nested
   dependency audit produced 2 follow-up issues."
   ```

3. Refresh the wiki and stash indexes:

   ```sh
   akm wiki ingest {{ knowledge_wiki }}
   akm index
   akm wiki lint {{ knowledge_wiki }}
   ```

### Completion Criteria
- `release-book.md` has no empty sections.
- A memory linking this orchestrator run to its release version is
  stored.
- `akm index` and `akm wiki lint {{ knowledge_wiki }}` complete cleanly.
