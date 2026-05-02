---
description: Take a written spec or issue from "agreed on the shape" to a merged, deployed change. Optimised for the case where the work is too small to need full release-train ceremony but too important to YOLO straight into main.
tags:
  - example
  - features
  - delivery
  - tdd
  - vault
params:
  spec_ref: "Reference to the agreed spec — a stash asset (e.g. `wiki:engineering/spec-foo`), an issue (`gh:itlackey/akm#214`), or a path under the run workspace."
  base_branch: "Branch to cut the feature branch from. Defaults to `main`."
  feature_slug: "Short kebab-case slug used in branch and PR names (e.g. `fts5-tokenizer-v2`)."
  workspace_dir: "Directory for run artefacts. Defaults to `.akm-run/{{ runId }}`."
  vault: "Optional vault ref for any credentials the test or deploy needs (e.g. `vault:integration-tests`)."
  knowledge_wiki: "AKM wiki to consult for prior decisions and update with new ones. Defaults to `engineering`."
---

# Workflow: Ship Feature From Spec

A pragmatic delivery loop: read the spec, write the test first, make it
pass, leave the codebase a little better than you found it, and document
the decision so the next person who touches this code finds your reasoning
instead of guessing it.

## Step: Anchor the spec and decision context
Step ID: anchor-spec

### Instructions
Before writing any code, make sure you actually understand the spec the same
way the person who wrote it does.

1. Resolve `spec_ref` and copy its content into
   `{{ workspace_dir }}/spec.md`. If the spec lives in the wiki:

   ```sh
   akm show {{ spec_ref }} > {{ workspace_dir }}/spec.md
   ```

2. Search for related decisions and prior implementations:

   ```sh
   akm search "{{ feature_slug }}"
   akm wiki search {{ knowledge_wiki }} "{{ feature_slug }}"
   ```

   Capture relevant hits in `{{ workspace_dir }}/related.md` with one line on
   why each matters.
3. Write `{{ workspace_dir }}/understanding.md` in your own words: what is
   in scope, what is explicitly out of scope, what the success criteria are,
   and any open questions. If there are open questions, block the run and
   ask them — do not guess.

### Completion Criteria
- `spec.md` is a verbatim copy of the agreed spec.
- `related.md` lists prior art and notes whether each constrains this work.
- `understanding.md` states scope, non-goals, and success criteria; open
  questions either resolved or surfaced as blockers.

## Step: Cut the branch and the failing test
Step ID: failing-test

### Instructions
Test-first is non-negotiable here. The test encodes the spec; the test
passing is the definition of done.

1. Cut the branch from a fresh base:

   ```sh
   git fetch origin {{ base_branch }}
   git switch -c feat/{{ feature_slug }} origin/{{ base_branch }}
   ```

2. Write the smallest test that demonstrates the new behaviour, named to
   match the spec's success criterion. Place it next to the existing tests
   for the affected module.
3. Run the test and capture the failing output to
   `{{ workspace_dir }}/red.log`. The failure must be for the *right*
   reason — a missing implementation, not a typo or import error.
4. If the spec implies multiple behaviours, write the failing test for the
   most important one first. Stash the rest as `## Pending tests` in
   `{{ workspace_dir }}/test-plan.md`.

### Completion Criteria
- A feature branch `feat/{{ feature_slug }}` exists from a fresh base.
- A failing test exists and is committed; `red.log` shows it failing for
  the intended reason.
- `test-plan.md` lists the remaining tests to add as the implementation
  progresses.

## Step: Implement the smallest change that makes it green
Step ID: implement

### Instructions
Resist the urge to refactor while implementing. Make it work first; tidy
in a separate step.

1. Implement the smallest change that turns `red.log` into a passing run.
   Avoid touching files unrelated to the failing test.
2. Run the project's gates after each meaningful edit:

   ```sh
   bunx biome check --write src/ tests/
   bunx tsc --noEmit
   bun test
   ```

3. As each pending test from `test-plan.md` becomes relevant, add it,
   watch it fail, then make it pass. Commit per logical change with a
   message that explains *why*, not what.
4. If a planned approach hits a wall, do not silently change the spec.
   Stop, document the wall in `{{ workspace_dir }}/blockers.md`, and
   either revise `understanding.md` (if the user agrees) or block the
   run.

### Completion Criteria
- All tests in `test-plan.md` are added and passing.
- Lint, typecheck, and test gates pass cleanly on the branch.
- Every commit message names the *why*, not just the *what*.

## Step: Tidy and harden
Step ID: tidy

### Instructions
Now you are allowed to refactor — but only what you touched, and only what
the diff already justifies.

1. Re-read the diff (`git diff origin/{{ base_branch }}...HEAD`) as if
   you were the reviewer:
   - Are there obvious naming improvements in code you already changed?
   - Is there a comment explaining a non-obvious invariant where it would
     genuinely help?
   - Is there dead code, debug logging, or commented-out blocks?
2. Apply only changes that the existing diff already justifies. Resist
   sweeping refactors; file them as follow-up issues instead.
3. Re-run gates. If anything regresses, the tidy was too aggressive —
   revert and try a smaller pass.

### Completion Criteria
- The diff contains no dead code, debug prints, or unrelated formatting.
- Refactors are confined to files the feature already touched.
- Out-of-scope cleanups are filed as follow-up issues, not bundled in.

## Step: Verify in an integration-like environment
Step ID: verify-integration

### Instructions
Unit tests are necessary, not sufficient. Exercise the change through the
real entry points before opening the PR.

1. If the change has a CLI surface, run it end-to-end with realistic
   inputs and capture the transcripts to
   `{{ workspace_dir }}/integration.log`.
2. If the change has a UI surface, run it in the dev server and verify the
   golden path *and* the most plausible edge cases. Note explicitly in
   `integration.log` if you could not exercise the UI.
3. If integration requires credentials, load them only into the test
   shell:

   ```sh
   source <(akm vault load {{ vault }})
   ```

   The credentials must never appear in `integration.log`.
4. If integration uncovers a gap, return to `failing-test` with a new test
   that catches it.

### Completion Criteria
- `integration.log` shows the change exercised through realistic entry
  points.
- Any UI changes were verified manually and that verification is recorded.
- Credentials never appear in any artefact written to the workspace.

## Step: Open the PR and document the decision
Step ID: open-pr-and-document

### Instructions
The PR is the durable artefact. Make it readable.

1. Push the branch and open the PR:

   ```sh
   git push -u origin feat/{{ feature_slug }}
   gh pr create --base {{ base_branch }} --title "feat: {{ feature_slug }}" \
     --body-file {{ workspace_dir }}/pr-body.md
   ```

   Build `pr-body.md` from `understanding.md` (intent and scope),
   `test-plan.md` (verification), and a manual test plan derived from
   `integration.log`.
2. If the spec implied a non-trivial architectural choice, write or
   update an ADR-style page under `wiki:{{ knowledge_wiki }}/decisions/`
   recording the choice, the rejected alternatives, and the reasoning.
3. Re-index so the new decision is searchable:

   ```sh
   akm wiki ingest {{ knowledge_wiki }}
   akm index
   ```

4. Record any heuristics you'd want next time:

   ```sh
   akm remember "When implementing tokenizer features, write the FTS5
   round-trip test before touching the parser — saved an afternoon."
   ```

### Completion Criteria
- A PR is open with a body that summarises intent, verification, and
  manual test plan.
- Architectural decisions implied by the spec are recorded as a wiki
  page under `decisions/`.
- The knowledge wiki and stash index are refreshed.
