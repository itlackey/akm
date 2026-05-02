---
description: Review a single pull request against the project's actual conventions and prior decisions, leaving structured feedback that an author can act on without a follow-up call. Doubles as a way to capture review heuristics back into the stash.
tags:
  - example
  - code-review
  - pull-requests
  - feedback
  - memory
params:
  pr_ref: "Pull request reference (e.g. `gh:itlackey/akm#214`, or a freeform PR ID for non-GitHub forges)."
  reviewer_persona: "Optional persona ref to bias the review (e.g. `skill:senior-typescript-reviewer`, `skill:security-reviewer`). Defaults to a generalist reviewer."
  workspace_dir: "Directory for run artefacts. Defaults to `.akm-run/{{ runId }}`."
  conventions_query: "Search query used to discover project conventions in the stash (e.g. `error handling conventions`, `react component style`). Defaults to the PR title."
  knowledge_wiki: "AKM wiki to consult for prior architectural decisions and to update with new heuristics. Defaults to `engineering`."
---

# Workflow: Code Review PR

A repeatable structure for high-signal PR review. The goal is to give the
author the smallest set of changes that materially improve the patch — not to
relitigate the architecture and not to nit-pick. The workflow also captures
durable lessons so the next reviewer benefits from this one's effort.

## Step: Load the PR and surface relevant prior art
Step ID: load-context

### Instructions
A review starts with context the author already had, not a blank slate.

1. Pull the PR metadata and diff:

   ```sh
   gh pr view {{ pr_ref }} --json title,body,author,headRefName,baseRefName,additions,deletions,files,labels
   gh pr diff {{ pr_ref }} > {{ workspace_dir }}/pr.diff
   ```

   Cache the JSON in `{{ workspace_dir }}/pr-meta.json`.
2. Discover project conventions relevant to the changed surfaces:

   ```sh
   akm search "{{ conventions_query }}"
   akm wiki search {{ knowledge_wiki }} "{{ conventions_query }}"
   ```

   Record the top 5 hits in `{{ workspace_dir }}/conventions.md` with a
   one-line note on whether each applies to this PR.
3. If `reviewer_persona` is set, load it and treat its review rubric as the
   authoritative checklist:

   ```sh
   akm show {{ reviewer_persona }}
   ```

### Completion Criteria
- `pr-meta.json` and `pr.diff` are saved to disk for offline re-reading.
- `conventions.md` lists relevant stash and wiki hits with applicability
  notes.
- The reviewer persona (if any) is loaded; otherwise the run notes
  explicitly state the generalist rubric is in use.

## Step: Read the change with intent
Step ID: read-with-intent

### Instructions
Three passes, in order. Do not skip ahead.

1. **What is the PR trying to do?** Read the description and the linked
   issue. Write a one-paragraph summary in
   `{{ workspace_dir }}/intent.md`. If you cannot articulate the intent
   from the description, that is itself review feedback — record it.
2. **Does the diff implement the stated intent?** Walk the files in the
   order the author put them in the PR. For each file, note in
   `{{ workspace_dir }}/walkthrough.md`:
   - what changed in this file
   - whether it serves the intent or seems orthogonal
   - any callers/tests it implies but does not include
3. **What did the diff *not* change that you expected?** Missing test
   coverage, missing migration, missing changelog entry, missing
   documentation. Record those gaps separately under a `## Gaps` section
   in `walkthrough.md`.

### Completion Criteria
- `intent.md` summarises the goal in your own words.
- `walkthrough.md` covers every file in the diff and lists expected-but-
  missing changes under `Gaps`.
- Off-topic refactors are flagged for the author to split out, not
  silently approved.

## Step: Apply the rubric
Step ID: apply-rubric

### Instructions
Score the PR against an explicit rubric so feedback is calibrated, not
vibes-based.

For each rubric item, write a verdict in
`{{ workspace_dir }}/rubric.md`: `pass`, `concern`, `block`, with one
line of justification.

Default rubric (extend per `reviewer_persona`):

1. **Correctness** — does it implement the stated intent and only that?
2. **Tests** — is the new behaviour covered, including edge cases the diff
   itself implies (boundary conditions, error paths, concurrency)?
3. **Conventions** — does it match the patterns in `conventions.md`, or
   if it diverges, is the divergence justified in the PR body?
4. **Security and data integrity** — any new input is validated, secrets
   never logged, no obvious injection or auth bypass.
5. **Reversibility** — can this be reverted cleanly? Database migrations
   and feature flag flips are called out.
6. **Diff hygiene** — no unrelated formatting, no dead code, no debug
   logging, commit messages explain the *why*.

Promote a `block` verdict only when the issue would harm production or
permanently regress a contract. A code style preference is a `concern`,
not a `block`.

### Completion Criteria
- Every rubric item has a verdict and a one-line justification.
- `block` verdicts cite a concrete production or contract harm.
- Style preferences are filed as `concern`, not `block`.

## Step: Post the review
Step ID: post-review

### Instructions
A good review reads as a single coherent message, not 14 separate inline
comments that contradict each other.

1. Draft `{{ workspace_dir }}/review.md` with this structure:
   - **Summary**: 2–3 sentences on what this PR does and overall verdict.
   - **Required to merge** (`block` items): each one tied to a file/line
     and the rubric item it failed.
   - **Strongly suggested** (`concern` items): same structure, but
     explicitly optional.
   - **Optional / nits**: clearly labelled, never promoted.
   - **What worked well**: at least one specific thing — calibration
     matters as much for praise as for criticism.
2. Post the review:

   ```sh
   gh pr review {{ pr_ref }} --request-changes -F {{ workspace_dir }}/review.md
   ```

   (Use `--approve` or `--comment` instead if there are no `block`
   items.)
3. Record inline comments only for items that need to point to a specific
   line and would be ambiguous in the summary.

### Completion Criteria
- A single review is posted with `block`, `concern`, and nit sections
  clearly separated.
- Inline comments exist only where a line reference is necessary.
- The review includes at least one specific positive observation.

## Step: Capture durable heuristics
Step ID: capture-heuristics

### Instructions
A review that taught you something should leave a trace beyond the PR
thread.

1. If a recurring pattern surfaced (good or bad) that future reviews
   should look for, add or update a page under `wiki:{{ knowledge_wiki }}`
   describing it. One page per pattern, not one mega-page.
2. Save personal review heuristics with `akm remember`:

   ```sh
   akm remember "When reviewing PRs that touch the FTS5 indexer, always
   check that schema-version bumps are handled in db.ts and not just in
   schema.ts."
   ```

3. If you used a reviewer persona and it surfaced a useful prompt or
   missed something important, signal that with `akm feedback`:

   ```sh
   akm feedback {{ reviewer_persona }} --positive --note "Caught an
   auth-bypass pattern I would have missed."
   # or
   akm feedback {{ reviewer_persona }} --negative --note "Missed an
   obvious test gap; rubric needs a coverage step."
   ```

4. Re-index so future reviews find the new material:

   ```sh
   akm wiki ingest {{ knowledge_wiki }}
   akm index
   ```

### Completion Criteria
- At least one of: a wiki page added/updated, a memory recorded, or an
  explicit note that this PR carried no durable lesson.
- If `reviewer_persona` was used, a feedback signal is recorded.
- `akm index` and `akm wiki ingest` complete cleanly.
