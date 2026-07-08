# PR #714 Workflow Validation Reproduction

This runbook records the exact regression and validation steps used after the
latest fixes on PR #714.

## Preconditions

- `bun` installed and working
- `sqlite3` installed
- `opencode` installed and authenticated if you want to run the live harness
  scenario
- this repo checked out locally

Define your repo root at runtime so the repro stays portable across machines:

```sh
REPO_ROOT="$(git rev-parse --show-toplevel)"
CLI="$REPO_ROOT/src/cli.ts"
```

Branch used:

```sh
git checkout claude/workflow-orchestration-improvements-k39vjo
git pull --ff-only
```

## Automated Test Pass

Run the workflow-focused suites that cover the addressed review findings and
the surrounding orchestration surfaces:

```sh
bun test \
  tests/commands/workflow-driver-cli.test.ts \
  tests/workflows/brief.test.ts \
  tests/workflows/report.test.ts \
  tests/workflows/conformance/driver-parity.test.ts \
  tests/workflows/dispatch-disposal.test.ts \
  tests/workflows/validate-summary.test.ts \
  tests/integration/worktree-isolation.test.ts

bun test \
  tests/workflow-cli.test.ts \
  tests/workflows/status-units.test.ts \
  tests/workflows/program-warnings.test.ts \
  tests/workflows/scheduler.test.ts
```

Expected result on the validated branch:

- 203 passing tests
- 0 failures

## Manual Sandbox Setup

Use a throwaway sandbox so host config, caches, and stash contents do not
affect the results.

```sh
export REPRO_ROOT=/tmp/opencode/workflow-pr714-repro
mkdir -p "$REPRO_ROOT"/{home,xdg-config,xdg-data,xdg-cache,xdg-state,stash,project}

export PROJECT_A="$REPRO_ROOT/project"
export PROJECT_B="$REPRO_ROOT/project-b"
export WORKFLOW_DB="$REPRO_ROOT/xdg-data/akm/workflow.db"

export HOME="$REPRO_ROOT/home"
export XDG_CONFIG_HOME="$REPRO_ROOT/xdg-config"
export XDG_DATA_HOME="$REPRO_ROOT/xdg-data"
export XDG_CACHE_HOME="$REPRO_ROOT/xdg-cache"
export XDG_STATE_HOME="$REPRO_ROOT/xdg-state"
export AKM_STASH_DIR="$REPRO_ROOT/stash"

bun "$CLI" init
```

Replace `config.json` with this minimal reproducible config:

```sh
mkdir -p "$XDG_CONFIG_HOME/akm"
cat > "$XDG_CONFIG_HOME/akm/config.json" <<'EOF'
{
  "semanticSearchMode": "off",
  "registries": [
    {
      "url": "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
      "name": "akm-registry"
    },
    {
      "url": "https://skills.sh",
      "name": "skills.sh",
      "provider": "skills-sh",
      "enabled": false
    }
  ],
  "output": {
    "format": "json",
    "detail": "brief"
  },
  "stashDir": "/tmp/opencode/workflow-pr714-repro/stash",
  "defaults": {
    "agent": "opencode"
  },
  "modelAliases": {
    "balanced": {
      "*": "openai/gpt-5.4-mini"
    },
    "deep": {
      "*": "openai/gpt-5.4"
    }
  },
  "profiles": {
    "agent": {
      "opencode": {
        "platform": "opencode",
        "workspace": "/tmp/opencode/workflow-pr714-repro/project"
      },
      "reviewer": {
        "platform": "opencode",
        "workspace": "/tmp/opencode/workflow-pr714-repro/project",
        "modelAliases": {
          "deep": "openai/gpt-5.4-mini"
        }
      }
    }
  }
}
EOF
```

Initialize a disposable git repo for worktree-isolation testing:

```sh
mkdir -p "$PROJECT_A" "$PROJECT_B"

git init "$PROJECT_A"
git -C "$PROJECT_A" config user.email "test@example.com"
git -C "$PROJECT_A" config user.name "Workflow Test"
touch "$PROJECT_A/README.md"
git -C "$PROJECT_A" add README.md
git -C "$PROJECT_A" commit -m "init"
```

Create these workflow assets under `$AKM_STASH_DIR/workflows/`.

### `basic-check.yaml`

```sh
cat > "$AKM_STASH_DIR/workflows/basic-check.yaml" <<'EOF'
version: 1
name: basic-check
description: External-driver review flow with fan-out, aggregation, routing, and a final step.

params:
  files: { type: array, items: { type: string } }

defaults:
  runner: agent
  timeout: 10m
  on_error: fail

steps:
  - id: review
    title: Review Files
    map:
      over: ${{ params.files }}
      concurrency: 3
      reducer: collect
      unit:
        profile: reviewer
        model: deep
        instructions: |
          Review ${{ item }} and return JSON with file and verdict.
        output:
          type: object
          properties:
            file: { type: string }
            verdict: { type: string }
          required: [file, verdict]

  - id: aggregate
    title: Aggregate Verdict
    unit:
      profile: reviewer
      model: balanced
      instructions: |
        Summarize the collected review verdicts and return JSON with a single verdict.
        Input: ${{ steps.review.output }}
      output:
        type: object
        properties:
          verdict: { type: string }
        required: [verdict]

  - id: triage
    title: Route Outcome
    route:
      input: ${{ steps.aggregate.output.verdict }}
      when: { pass: ship, fail: rework }
      default: manual-triage

  - id: ship
    title: Ship
    unit:
      instructions: |
        Confirm the change can ship.

  - id: rework
    title: Rework
    unit:
      instructions: |
        Explain why the change needs rework.

  - id: manual-triage
    title: Manual Triage
    unit:
      instructions: |
        Escalate the ambiguous outcome for human review.
EOF
```

### `gate-block.yaml`

```sh
cat > "$AKM_STASH_DIR/workflows/gate-block.yaml" <<'EOF'
version: 1
name: gate-block
description: Required gate without a configured judge should block rather than fail open.

steps:
  - id: draft
    title: Draft
    unit:
      instructions: |
        Produce a short completion note.
    gate:
      criteria:
        - The completion note clearly states the work is done.
      required: true
EOF
```

### `token-budget.yaml`

```sh
cat > "$AKM_STASH_DIR/workflows/token-budget.yaml" <<'EOF'
version: 1
name: token-budget
description: Budget ceiling for externally reported fan-out units.

params:
  files: { type: array, items: { type: string } }

budget:
  max_tokens: 100

steps:
  - id: review
    title: Budgeted Review
    map:
      over: ${{ params.files }}
      concurrency: 3
      reducer: collect
      unit:
        instructions: |
          Review ${{ item }} and return a short verdict string.
        on_error: continue
EOF
```

### `worktree-proof.yaml`

```sh
cat > "$AKM_STASH_DIR/workflows/worktree-proof.yaml" <<'EOF'
version: 1
name: worktree-proof
description: Real agent run that mutates files so worktree isolation can be observed.

defaults:
  runner: agent
  timeout: 10m
  on_error: fail

steps:
  - id: mutate
    title: Mutate In Isolation
    unit:
      profile: opencode
      isolation: worktree
      instructions: |
        In the current working directory, create a file named worktree-sentinel.txt
        with the exact contents "workflow isolation ok" followed by a newline.
        Then respond with exactly: done
EOF
```

Index and validate the sandbox stash:

```sh
bun "$CLI" index --full

bun "$CLI" workflow validate workflow:basic-check
bun "$CLI" workflow validate workflow:gate-block
bun "$CLI" workflow validate workflow:token-budget
bun "$CLI" workflow validate workflow:worktree-proof
```

Expected result:

- all four validates return `ok: true`
- additive warnings are expected for steps without step-level `output:` schemas

## Manual Scenario 1: External Driver Claim Rendering

Start the run and inspect the initial brief:

```sh
START_JSON=$(bun "$CLI" workflow start workflow:basic-check --params '{"files":["src/a.ts"]}')
RUN_ID=$(printf '%s' "$START_JSON" | bun -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).run.id)')
BRIEF_JSON=$(bun "$CLI" workflow brief "$RUN_ID")
UNIT_ID=$(printf '%s' "$BRIEF_JSON" | bun -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).workList.units[0].unitId)')
```

Expected result:

- one pending unit in `UNIT_ID`

Claim it, then brief again:

```sh
bun "$CLI" workflow report "$RUN_ID" \
  --unit "$UNIT_ID" \
  --expect-step review \
  --status running \
  --note 'claim src/a.ts' > claim.json

CLAIM_HOLDER=$(bun -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync("claim.json","utf8")).claim.holder)')
bun src/cli.ts workflow brief "$RUN_ID"
bun "$CLI" workflow brief "$RUN_ID"
```

Expected result:

- the unit is rendered as `action: "claimed"`
- `journaled.claimedBy` is set
- the per-unit `report` command now includes `--session-id $CLAIM_HOLDER`

## Manual Scenario 2: Required Gate Blocks, `--active` Excludes It, Resume + Settle Works

```sh
BLOCKED_START=$(bun "$CLI" workflow start workflow:gate-block)
BLOCKED_RUN_ID=$(printf '%s' "$BLOCKED_START" | bun -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).run.id)')

bun "$CLI" workflow report workflow:gate-block \
  --unit draft:solo \
  --expect-step draft \
  --status completed \
  --result 'the work is done'

bun "$CLI" workflow list --active
```

Expected result:

- the gate-block run becomes `blocked`
- the blocked run is absent from `workflow list --active`

Resume it and inspect the brief:

```sh
bun "$CLI" workflow resume "$BLOCKED_RUN_ID"
bun "$CLI" workflow brief "$BLOCKED_RUN_ID"
```

Notes:

- `workflow resume` currently takes a run id, not a workflow ref

Expected result:

- the only unit is `action: "done"`
- `settleCommand` is present
- the `message` explicitly tells the operator to run `akm workflow report --settle`

Finalize through the new settle path:

```sh
bun "$CLI" workflow report "$BLOCKED_RUN_ID" \
  --settle \
  --expect-step draft
```

Expected result:

- the step re-blocks cleanly because the required gate still has no judge
- the result is a structured blocked outcome, not a stranded active run

## Manual Scenario 3: Budget Ceiling on the Report Path

```sh
BUDGET_START=$(bun "$CLI" workflow start workflow:token-budget --params '{"files":["a.ts","b.ts","c.ts"]}')
BUDGET_RUN_ID=$(printf '%s' "$BUDGET_START" | bun -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).run.id)')

bun "$CLI" workflow report "$BUDGET_RUN_ID" \
  --unit review.unit:8b3148685648 \
  --expect-step review \
  --status completed \
  --tokens 60 \
  --result 'pass a'

bun "$CLI" workflow report "$BUDGET_RUN_ID" \
  --unit review.unit:630647ca5751 \
  --expect-step review \
  --status completed \
  --tokens 50 \
  --result 'pass b'
```

Expected result:

- the second completion fails the step hard
- the summary names `budget exceeded (max_tokens ceiling)`
- `on_error: continue` does not override the budget ceiling

## Manual Scenario 4: Stale Claim Reclaim

Start a fresh run, claim the unit, then simulate a dead driver by aging the
claim in `workflow.db`.

```sh
STALE_START=$(bun "$CLI" workflow start workflow:basic-check --force --params '{"files":["stale.ts"]}')
STALE_RUN_ID=$(printf '%s' "$STALE_START" | bun -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).run.id)')
STALE_BRIEF=$(bun src/cli.ts workflow brief "$STALE_RUN_ID")
STALE_UNIT_ID=$(printf '%s' "$STALE_BRIEF" | bun -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).workList.units[0].unitId)')

bun src/cli.ts workflow report "$STALE_RUN_ID" \
  --unit "$STALE_UNIT_ID" \
  --expect-step review \
  --status running \
  --note 'claim stale.ts'

sqlite3 "$WORKFLOW_DB" \
  "update workflow_run_units set last_checkin_at='2000-01-01T00:00:00.000Z', claim_expires_at='2000-01-01T00:00:00.000Z' where run_id='$STALE_RUN_ID' and unit_id='$STALE_UNIT_ID';"

bun "$CLI" workflow brief "$STALE_RUN_ID"
```

Expected result:

- the unit is rendered as `action: "stale"`
- `staleUnits` contains that unit id
- a new driver can then finish it without the old `--session-id`

Optional completion step:

```sh
bun "$CLI" workflow report "$STALE_RUN_ID" \
  --unit "$STALE_UNIT_ID" \
  --expect-step review \
  --status completed \
  --result '{"file":"stale.ts","verdict":"pass"}'
```

## Manual Scenario 5: Scope Isolation Across Working Directories

Start the same workflow in two different directories.

```sh
SCOPE_A_START=$(bun "$CLI" workflow start workflow:basic-check --force --params '{"files":["scope-a.ts"]}')
SCOPE_RUN_A=$(printf '%s' "$SCOPE_A_START" | bun -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).run.id)')
```

Run this second command from `PROJECT_B`:

```sh
bun "$CLI" workflow start workflow:basic-check --params '{"files":["scope-b.ts"]}'
```

Then list active runs in each directory separately:

```sh
bun "$CLI" workflow list --active
```

Expected result:

- from `PROJECT_A`, the active list contains only the `scope-a.ts` run
- from `PROJECT_B`, the active list contains only the `scope-b.ts` run
- the two runs have different `scopeKey` values

## Manual Scenario 6: Watch A Blocked Run In Stream Mode

```sh
bun "$CLI" workflow watch "$BLOCKED_RUN_ID" --stream --interval-ms 5
```

Expected result:

- emits the run's `workflow_*` event backlog as NDJSON
- exits on its own with a trailing `workflow-watch` envelope
- the trailing envelope reports `status: "blocked"` and `streamed: true`

## Manual Scenario 7: Live Worktree Isolation

Run from inside the disposable git repo:

```sh
cd "$PROJECT_A"

bun "$CLI" workflow run workflow:worktree-proof --max-steps 1
```

Expected functional result:

- the run returns `status: "completed"`
- stderr prints a retained isolation worktree path like:
  `/tmp/akm-worktrees/<run-id>/mutate-solo`
- the main repo stays clean:

```sh
git -C "$REPRO_ROOT/project" status --short
test ! -f "$REPRO_ROOT/project/worktree-sentinel.txt"
```

- the worktree path is journaled:

```sh
WORKTREE_RUN_ID=<run id from the workflow-run output>

sqlite3 "$XDG_DATA_HOME/akm/workflow.db" \
  "select unit_id, worktree_path from workflow_run_units where run_id = '$WORKTREE_RUN_ID';"
```

Expected result from the validated branch:

- the command prints the successful completed payload and exits naturally
- the retained worktree path is still journaled correctly
- the base repo still stays clean

## Manual Scenario 8: Cross-Harness Cleanup Comparison (`opencode`, `codex`, `claude`)

Use a second sandbox so the cross-harness comparison is isolated from the main
workflow repro state.

### Additional Preconditions

- `codex` installed and authenticated if you want to run the Codex variant
- `claude` installed, authenticated, and funded/authorized if you want to run
  the Claude Code variant

### Cross-Harness Setup

```sh
export MULTI_ROOT=/tmp/opencode/workflow-multi-harness-check
mkdir -p "$MULTI_ROOT"/{home,xdg-config,xdg-data,xdg-cache,xdg-state,stash,project}

export HOME="$MULTI_ROOT/home"
export XDG_CONFIG_HOME="$MULTI_ROOT/xdg-config"
export XDG_DATA_HOME="$MULTI_ROOT/xdg-data"
export XDG_CACHE_HOME="$MULTI_ROOT/xdg-cache"
export XDG_STATE_HOME="$MULTI_ROOT/xdg-state"
export AKM_STASH_DIR="$MULTI_ROOT/stash"

bun src/cli.ts init

mkdir -p "$XDG_CONFIG_HOME/akm"
cat > "$XDG_CONFIG_HOME/akm/config.json" <<'EOF'
{
  "semanticSearchMode": "off",
  "registries": [
    {
      "url": "https://raw.githubusercontent.com/itlackey/akm-registry/main/index.json",
      "name": "akm-registry"
    },
    {
      "url": "https://skills.sh",
      "name": "skills.sh",
      "provider": "skills-sh",
      "enabled": false
    }
  ],
  "output": {
    "format": "json",
    "detail": "brief"
  },
  "stashDir": "/tmp/opencode/workflow-multi-harness-check/stash",
  "profiles": {
    "agent": {
      "opencode": {
        "platform": "opencode",
        "workspace": "/tmp/opencode/workflow-multi-harness-check/project"
      },
      "codex": {
        "platform": "codex",
        "workspace": "/tmp/opencode/workflow-multi-harness-check/project"
      },
      "claude": {
        "platform": "claude",
        "workspace": "/tmp/opencode/workflow-multi-harness-check/project"
      }
    }
  }
}
EOF

git init "$MULTI_ROOT/project"
git -C "$MULTI_ROOT/project" config user.email "test@example.com"
git -C "$MULTI_ROOT/project" config user.name "Workflow Test"
touch "$MULTI_ROOT/project/README.md"
git -C "$MULTI_ROOT/project" add README.md
git -C "$MULTI_ROOT/project" commit -m "init"
```

Create one workflow per harness so the final run records stay distinct.

```sh
cat > "$AKM_STASH_DIR/workflows/worktree-proof-opencode.yaml" <<'EOF'
version: 1
name: worktree-proof-opencode
description: Minimal live harness cleanup repro for opencode.

defaults:
  runner: agent
  timeout: 10m
  on_error: fail

steps:
  - id: mutate
    title: Mutate In Isolation
    unit:
      profile: opencode
      isolation: worktree
      instructions: |
        In the current working directory, create a file named worktree-sentinel.txt
        with the exact contents "workflow isolation ok" followed by a newline.
        Then respond with exactly: done
EOF

cat > "$AKM_STASH_DIR/workflows/worktree-proof-codex.yaml" <<'EOF'
version: 1
name: worktree-proof-codex
description: Minimal live harness cleanup repro for codex.

defaults:
  runner: agent
  timeout: 10m
  on_error: fail

steps:
  - id: mutate
    title: Mutate In Isolation
    unit:
      profile: codex
      isolation: worktree
      instructions: |
        In the current working directory, create a file named worktree-sentinel.txt
        with the exact contents "workflow isolation ok" followed by a newline.
        Then respond with exactly: done
EOF

cat > "$AKM_STASH_DIR/workflows/worktree-proof-claude.yaml" <<'EOF'
version: 1
name: worktree-proof-claude
description: Minimal live harness cleanup repro for claude code.

defaults:
  runner: agent
  timeout: 10m
  on_error: fail

steps:
  - id: mutate
    title: Mutate In Isolation
    unit:
      profile: claude
      isolation: worktree
      instructions: |
        In the current working directory, create a file named worktree-sentinel.txt
        with the exact contents "workflow isolation ok" followed by a newline.
        Then respond with exactly: done
EOF

bun src/cli.ts index --full
```

### Execution

Run all three from the disposable git repo. Use a caller timeout so a cleanup
hang is visible.

```sh
cd "$MULTI_ROOT/project"

bun "$CLI" workflow run workflow:worktree-proof-opencode --max-steps 1
bun "$CLI" workflow run workflow:worktree-proof-codex --max-steps 1
bun "$CLI" workflow run workflow:worktree-proof-claude --max-steps 1
```

Then inspect terminal state and diagnostics:

```sh
bun src/cli.ts workflow status <opencode-run-id> --units
bun src/cli.ts workflow status <codex-run-id> --units
bun src/cli.ts workflow status <claude-run-id> --units
```

### Expected Interpretation

- `opencode`: if configured correctly, the unit should succeed, retain an
  isolation worktree when dirty, and the parent command should exit naturally
- `codex`: if not authenticated, expect a terminal failed run with
  `failureReason: non_zero_exit` and diagnostic text showing authentication
  errors; the parent command should still exit naturally after printing the
  terminal failed result
  - note: `codex exec` defaults to a read-only sandbox that blocks file writes,
    so a unit that needs to create files (e.g. the worktree sentinel) would
    fail even when authenticated
  - the akm codex builder now injects `--sandbox workspace-write` so dispatched
    units can actually write files in their working directory
  - if the codex sandbox helper binary is unavailable (e.g. sandboxed HOME
    under `/tmp`), the codex unit may still fail with
    `sandbox helper missing` despite the `--sandbox workspace-write` flag
- `claude`: if the local account lacks credits or authorization, expect a
  terminal failed run with `failureReason: non_zero_exit` and diagnostic text
  such as `Credit balance is too low`; the parent command should still exit
  naturally

### Results Observed On This Machine

- `opencode`
  - workflow reached `completed`
  - base repo stayed clean
  - retained worktree was journaled
  - parent command exited normally after printing the successful result
- `codex`
  - workflow reached terminal `failed`
  - unit diagnostic showed repeated `401 Unauthorized: Missing bearer or basic authentication in header`
  - parent command exited normally after printing the terminal failed result
  - note: after applying the codex sandbox fix (commit `6a93892a`), codex
    dispatch completes successfully when `CODEX_HOME` is properly inherited,
    but may still fail in sandboxes where the `codex-linux-sandbox` helper
    cannot be created
- `claude`
  - workflow reached terminal `failed`
  - unit diagnostic showed `Credit balance is too low`
  - parent command exited normally after printing the terminal failed result

This matters because it separates two problems:

- harness/auth/account issues that explain whether the UNIT succeeds
- parent-process cleanup issues that explain whether `workflow run` exits after
  the run is already terminal

On the validated branch, the parent-process cleanup issue appears fixed for the
live harness repros exercised here.

### Cross-Harness Cleanup

```sh
rm -rf "$MULTI_ROOT"
```

Notes:

- if a retained worktree path was printed, remove the matching
  `/tmp/akm-worktrees/<run-id>` directory too
- do not kill unrelated long-lived `codex`, `claude`, or `opencode` desktop/web
  processes on a shared machine just to clean up this repro

## Cleanup

Clean up the sandbox directories and retained worktrees you created for this
repro.

```sh
for RUN in \
  "$RUN_ID" \
  "$BLOCKED_RUN_ID" \
  "$BUDGET_RUN_ID" \
  "$STALE_RUN_ID" \
  "$SCOPE_RUN_A" \
  "$WORKTREE_RUN_ID"
do
  if [ -n "$RUN" ]; then
    rm -rf "/tmp/akm-worktrees/$RUN"
  fi
done

rm -rf "$REPRO_ROOT"
```

Cleanup notes:

- do not blindly kill all `opencode serve` processes on a shared machine
- if the live harness scenario hangs, interrupt the parent command first, then
  remove only this repro's sandbox directories and run-scoped worktree paths

## Outcome Summary On The Validated Branch

Validated successfully:

- `workflow list --active` excludes blocked runs
- `brief` shows claimed units as `claimed` and injects `--session-id`
- blocked required-gate recovery now advertises and supports `report --settle`
- budget ceilings still fail hard as intended
- stale driver claims surface as `stale` and become reclaimable
- workflow runs stay isolated by working-directory scope
- `workflow watch --stream` exits cleanly on a blocked run
- worktree isolation still preserves dirty isolated work and keeps the base repo clean

Cross-harness comparison on this machine:

- `opencode` succeeded functionally and exited promptly after printing success
- `codex` failed functionally because the local harness lacked authentication,
  and still exited promptly after printing the terminal failure
- `claude` failed functionally because the local harness lacked usable credit,
  and still exited promptly after printing the terminal failure

## Production Task Examples From The Live Stash

The manual workflow above uses isolated repro assets so behavior is easy to
control. To make the verification reflect real production usage, also inspect
and validate task definitions that are live in the current stash today.

These examples are meant to prove that the manual verification maps to actual
production task shapes without executing live side effects such as Discord posts
or article ingestion.

### Example A: Prompt-Backed Production Task

Live task file:

```sh
readlink -f "$REPO_ROOT/tasks/curate-agent-learning.yml"
```

Current behavior encoded in the live task:

- schedule: daily at 12:15
- task shape: prompt-backed
- execution model: drives `workflow:curate-to-wiki` end to end
  - config source: `$REPO_ROOT/config/curation/agent-learning.json`

Safe verification steps:

```sh
sed -n '1,120p' "$REPO_ROOT/tasks/curate-agent-learning.yml"
sed -n '1,160p' "$REPO_ROOT/workflows/curate-to-wiki.md"
sed -n '1,120p' "$REPO_ROOT/config/curation/agent-learning.json"
```

What to confirm:

- the task really drives a durable workflow, not an ad-hoc shell script
- the workflow parameters in the prompt match the workflow frontmatter
- the config file exists and matches the workflow's topic/selection model
- the workflow contains the same production concerns we manually validated in
  the sandbox: preflight checks, multi-step advancement, blocking conditions,
  stash/ingest steps, and best-effort notification

Why this matters:

- it shows the manual workflow verification is not only testing synthetic
  examples; it matches a real prompt-driven production task that uses AKM's
  resumable workflow model today

### Example B: Command-Backed Production Task

Live task file:

```sh
readlink -f "$REPO_ROOT/tasks/akm-health-report.yml"
```

Current behavior encoded in the live task:

- schedule: hourly at minute 3
- task shape: command-backed
  - execution model: `akm env run ... -- bun "$REPO_ROOT/scripts/akm-health-discord.ts`
- production concern: env-injected external notification

Safe verification steps:

```sh
sed -n '1,80p' "$REPO_ROOT/tasks/akm-health-report.yml"
ls "$REPO_ROOT/scripts/akm-health-discord.ts"
```

What to confirm:

- the task exists and is enabled
- the command uses env injection rather than embedding secrets in the task file
- the target script path exists
- this production task shape is covered conceptually by the manual workflow:
  command-backed scheduled tasks, env-aware execution, and external side-effect
  boundaries that should be validated by setup/teardown rather than by blindly
  firing live notifications during a repro

### Example C: Production Orchestration Workflow Program

Live source workflow to convert:

```sh
readlink -f "$REPO_ROOT/workflows/web-ux-validation-gate.md"
```

Converted YAML workflow program created for manual verification:

```sh
readlink -f "$REPO_ROOT/workflows/web-ux-validation-gate-program.yaml"
```

Why this example is useful:

- it is a real production-style gate, not a toy repro flow
- it captures a binary gate with multi-stage review semantics
- it shows how an existing markdown workflow can be represented as a YAML
  workflow-program under the new orchestration model
- it validates cleanly with zero warnings on the current branch

Safe verification steps:

```sh
sed -n '1,220p' "$REPO_ROOT/workflows/web-ux-validation-gate.md"
sed -n '1,260p' "$REPO_ROOT/workflows/web-ux-validation-gate-program.yaml"

bun "$CLI" workflow validate "$REPO_ROOT/workflows/web-ux-validation-gate.md"
bun "$CLI" workflow validate "$REPO_ROOT/workflows/web-ux-validation-gate-program.yaml"
```

What to confirm:

- the YAML program preserves the same seven conceptual stages as the markdown source
- required params are represented explicitly in `params:`
- each stage is represented as a first-class unit step with typed outputs and gates
- the converted workflow validates as `format: program` with `warnings: []`
- this gives the manual test suite a realistic example of converting an existing
  production-quality markdown gate into the new workflow-program format

### Optional Safe Production-Context Checks

If you want an additional non-side-effect proof that these live assets are still
resolvable on the current machine, run:

```sh
akm workflow validate "$REPO_ROOT/workflows/curate-to-wiki.md"
akm search "curate-to-wiki" --type workflow
bun "$CLI" workflow validate "$REPO_ROOT/workflows/web-ux-validation-gate-program.yaml"
```

Do not run the live task commands/prompts directly during routine manual
verification unless you explicitly want to hit the real external systems they
notify or mutate.

Still observed manually:

- no manual cleanup hang reproduced in the rerun matrix (`opencode`, `codex`,
  `claude` all returned promptly)
