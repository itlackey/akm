# Workflows

A workflow is a structured markdown document that defines a multi-step
procedure. akm parses it, persists run state, and lets you advance through
steps one at a time — resuming after interruptions, blocking on human review
gates, and tracking completion criteria per step. The agent follows steps; the
human approves gates.

## akm workflow start

`akm workflow start` creates a new persisted run for a workflow asset. Run
state is scoped to the current project directory (nearest `.akm/config.json`,
git root, or stash root), so concurrent runs in different directories stay
independent.

```sh
akm workflow start workflow:ship-release
akm workflow start workflow:ship-release --params '{"version":"1.2.3"}'
```

The run snapshots the step list at start time. Edits to the source workflow
file after a run has started do not affect in-flight runs.

**Example: kick off a release**

```sh
akm workflow start workflow:ship-release --params '{"version":"2.0.0"}'
# → {"run": {"id":"<uuid>","status":"active","currentStepId":"validate",...}}
```

## akm workflow next / akm workflow step

`akm workflow next` returns the current actionable step for an active run. If
no active run exists for the given ref in the current scope, it auto-starts
one. This is the primary command an agent calls in a loop.

```sh
akm workflow next workflow:ship-release
akm workflow next <run-id>
akm workflow next workflow:ship-release --params '{"version":"1.2.3"}'  # auto-start params
```

The response includes the step object (`title`, `instructions`,
`completionCriteria`) or `"done": true` when the run is complete.

**Example: step through an onboarding workflow**

```sh
# Agent loop:
akm workflow next workflow:repo-onboarding
# read instructions → perform work → mark complete → repeat
akm workflow complete <run-id> --step setup-ci --notes "CI configured in .github/workflows/"
akm workflow next workflow:repo-onboarding
```

## akm workflow status

`akm workflow status` shows the full run state — all step statuses, notes, and
evidence — for a given run ID or workflow ref.

```sh
akm workflow status <run-id>
akm workflow status workflow:ship-release
# When given a ref, resolves to the most-recently-updated run in the current scope
```

Use this to inspect where a run is after a context window break, or to verify
all steps completed cleanly before closing a PR.

## akm workflow list

`akm workflow list` shows workflow runs in the current scope.

```sh
akm workflow list              # All runs in this scope
akm workflow list --active     # Only active runs
akm workflow list --ref workflow:ship-release  # Runs for a specific workflow
```

**Example: see what is in flight**

```sh
akm workflow list --active
# → lists runs by workflow ref, status, currentStepId, and updatedAt
```

## Writing a workflow

Workflow files are plain markdown with a specific heading structure. Use
`akm workflow template` to print a valid starter, then edit it and register it
with `akm workflow create`.

```sh
akm workflow template          # Print the template
akm workflow create my-release --from ./my-release.md
akm workflow validate workflow:my-release  # Check for errors before using it
```

**Minimal workflow format:**

```markdown
---
description: Ship a tagged release to production
params:
  version: The semver version string to release
---

# Workflow: Ship Release

## Step: Validate inputs
Step ID: validate

### Instructions
Check that `version` follows semver and the tag does not already exist.

### Completion Criteria
- `git tag v<version>` does not already exist
- Version string matches `^\d+\.\d+\.\d+$`

## Step: Build and test
Step ID: build

### Instructions
Run `npm run build && npm test`. Fix any failures before proceeding.
```

Rules: one `# Workflow: <title>` heading, each step is `## Step: <title>` with
a `Step ID: <id>` line and a `### Instructions` section. Completion criteria
are optional but recommended for human-review gates.

**Example: run a print book review workflow**

```sh
akm workflow start workflow:print-book-review --params '{"draft":"v3.pdf"}'
akm workflow next workflow:print-book-review
# agent reads instructions → runs checks → completes each step in sequence
```

## Security: workflow sources are executed code

Workflow steps that include shell commands run with **the full environment
and PATH of the user invoking `akm workflow next`** — same as if the user had
typed those commands in their shell. There is no sandbox, no env-var
allowlist, and no separation between trusted and untrusted workflows.

This is by design: a workflow is a runbook authored by you or by a stash
maintainer you trust. The flexibility of "run any shell command, read any
file, hit any network" is what makes workflows useful as automation.

The consequence is that **you should treat workflow sources the same way you
treat package dependencies**:

- **Only add workflow sources you trust.** `akm add github:<some-user>/stash`
  followed by `akm workflow next workflow:<their-thing>` is functionally
  equivalent to piping a stranger's bash script into your shell. Read the
  workflow file first (`akm show workflow:<name>`) before running it.
- **Audit before run** for any workflow that touches secrets, deploys to
  production, or writes outside the project tree. Workflow steps can read
  any environment variable visible to the akm process — including secrets
  exported by your shell or loaded from a vault via `akm vault load`.
- **Pin known-good versions** when adding workflow sources from a registry
  or git remote (`akm add github:owner/stash#v1.2.3`), and update
  deliberately rather than via `akm update --all`. A trusted workflow source
  can become hostile if its upstream is compromised.
- **Workflow steps cannot escape this trust model** by being labeled
  `dryRun` or `interactive` — those flags affect bookkeeping, not execution.
  An `akm workflow next` invocation always runs the next step's instructions
  in your shell.

If you operate a CI runner or shared host where untrusted workflows might be
executed, scope the process: a dedicated user account with no secrets in its
environment, ephemeral working directory, and a network/filesystem allowlist
enforced outside akm.

## See also

- [Search & Discovery](search-discovery.md) — find available workflows with `akm curate`
- [Knowledge Management](knowledge-management.md) — capture workflow outputs as memories
- [Improvement Loop](improvement-loop.md) — improve workflow assets over time
- [CLI Reference](../cli.md) — full flag documentation for all `workflow` subcommands
- [Concepts](../concepts.md) — workflow asset type and run-state storage
