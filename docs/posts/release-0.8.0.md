---
title: 'akm 0.8.0: CLI Redesign, Task Assets, and Belief-Aware Memory'
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm-releases
description: 'akm 0.8.0 introduces a redesigned `improve` command, task assets for persistent agent workflows, and belief-aware memory for more accurate stash updates.'
tags:
  - ai
  - agents
  - cli
  - release
published: true
---

akm 0.8.0 is out. This release combines the storage reorganization and CLI redesign with the final improve-owned maintenance migration: plain `akm index` now keeps metadata current, while slower memory inference and graph extraction maintenance run from `akm improve` after consolidation.

If you are on 0.7.x, the v1 migration guide covers the per-surface delta. The upgrade requires updating scripts and agent instructions due to breaking CLI changes.

## TL;DR

- **`akm improve`** — unified command for agent-driven asset refinement and post-loop maintenance.
- **Improve-owned maintenance** — memory inference and graph extraction now run from `akm improve`, not `akm index`.
- **Task assets** — first-class asset type for defining persistent agent workflows with scheduling, triggers, and context.
- **Belief-aware memory** — stash updates now incorporate the agent's belief state to prevent overwriting correct information.
- **Proposal queue commands renamed** — `akm proposals` (list), `akm show proposal`, `akm diff proposal`, `akm accept`, `akm reject`.
- **`akm health`** — runtime health report for `state.db`, task execution logs, agent availability, and recent improve telemetry.
- **CLI breaking changes** — proposal queue workflows are consolidated around `akm improve`, `akm propose`, `akm proposals`, `akm show proposal`, `akm diff`, `akm accept`, and `akm reject`; update your automation.
- **Release hardening** — empty-query search is a structured error again, `remember --enrich` now truly fail-softs, and the Docker install matrix is green for Bun and binary paths.

---

## `akm improve`: The New Self-Improvement Surface

The `akm improve` command consolidates asset refinement workflows. It can operate on a specific asset type (generating a new asset) or an existing asset ref (refining that asset). Under the hood, it uses the same proposal queue as before, ensuring all changes are reviewable before promotion.

```sh
akm improve <type> <name>          # generate a new asset of type <type> named <name> as a proposal
akm improve <ref>                  # refine an existing asset and produce a proposal
```

This consolidates the main proposal-oriented improvement workflow. It also now owns the slow maintenance passes that used to be coupled to indexing: after distill and consolidation settle the corpus, improve runs memory inference, reindexes if inference wrote new facts, and then refreshes graph extraction against the final post-improve state.

## Task Assets: Persistent Agent Workflows

Task assets (`tasks/<name>.yaml`) allow you to define long-running agent workflows that can be triggered on a schedule, by file changes, or manually. Each task runs in an isolated context and can propose updates to your stash via the improvement system.

Key features:
- **Cron-based scheduling** (with proper escaping for special characters)
- **File watch triggers** (react to changes in specific paths)
- **Manual invocation** via `akm task run <name>`
- **Isolated execution context** (each task gets its own working directory and environment)
- **Proposal-driven updates** (task agents propose changes via `akm improve`, which go through the proposal queue)

Example task asset:
```yaml
name: daily-code-review
trigger:
  cron: '0 9 * * *'  # every day at 9 AM
context:
  paths:
    - src/
  max_file_size: 65536
agent:
  command: opencode
  args: ["--task", "Review the staged changes and suggest improvements"]
```

## Belief-Aware Memory

Memory updates now consider the agent's belief state about the world. When an agent proposes to remember a fact, the system checks whether the agent currently believes that fact to be true (based on its recent observations and inferences) before allowing the update to proceed. This reduces the chance of overwriting correct stash content with outdated or incorrect beliefs.

This is implemented as a pre-write validation in the memory asset pipeline and can be tuned via the `memory.belief_aware` configuration flag (enabled by default).

## Proposal Queue: Renamed Commands

The proposal queue itself is unchanged, but the CLI surfaces have been renamed for consistency:

| Old Command          | New Command               |
|----------------------|---------------------------|
| `akm proposal list`  | `akm proposals`           |
| `akm proposal show`  | `akm show proposal`       |
| `akm proposal diff`  | `akm diff proposal`       |
| `akm proposal accept`| `akm accept`              |
| `akm proposal reject`| `akm reject`              |

All commands retain the same functionality and flags (e.g., `akm reject <id> --reason "..."`). There are no compatibility aliases—update your scripts and documentation.

## `akm health`: Runtime Checks in One Command

`akm health` provides a quick operator-facing snapshot of whether the local akm
runtime is healthy.

```sh
akm health
akm health --since 24h
akm health --since 7d --format text
```

It checks that `state.db` is readable and writable, verifies that required
tables exist, inspects `task_history` for missing log files or stale active
runs, probes the default agent profile, and summarizes recent `akm improve`
activity from `improve_invoked`, `improve_skipped`, and `improve_completed`
events.

This makes it easier to validate an upgraded installation after migration or to
spot regressions in task execution and improve-loop maintenance without querying
SQLite tables directly.

## Agent Command Builder: Platform-Aware Dispatch

`akm agent` can now embody a stash agent asset — setting the system prompt, model, and tool policy automatically from the asset's metadata:

```sh
akm agent opencode agent:code-reviewer --prompt "review src/commands/"
akm agent claude agent:planner --model sonnet --prompt "plan the next sprint"
```

The `<agent-ref>` positional resolves the agent asset's content as the system prompt, its `model:` frontmatter as the model, and its `tools:` frontmatter as the allowed tool set. Each platform gets the exact flags its CLI expects:

- **opencode**: `opencode run --system-prompt "..." --model opencode/claude-opus-4-7 "<prompt>"`
- **claude**: `claude --system-prompt "..." --model claude-opus-4-7 --allowedTools read,edit --print "<prompt>"`

Built-in model aliases (`opus`, `sonnet`, `haiku`) resolve to the correct model string per platform. Add custom aliases in `agent.profiles.<name>.modelAliases`. Override any asset's model for a single run with `--model`.

Without a prompt or agent-ref, `akm agent opencode` still launches the agent interactively — unchanged.

## Migration Guidance

Breaking changes in 0.8.0:
- Consolidated around: `akm improve`, `akm propose`, `akm proposals`, `akm show proposal`, `akm diff`, `akm accept`, `akm reject`
- Added: task assets, renamed proposal commands
- Added: `akm health` for runtime and improve telemetry checks
- Removed: `akm index --enrich` and `akm index --re-enrich`
- Changed: plain `akm index` now owns metadata enhancement only; slow LLM maintenance moved to `akm improve`
- Windows task path parsing now correctly handles absolute paths and drive letters
- Cron expressions with apostrophes are now properly escaped in schtasks XML

To upgrade:
1. Update any scripts or automation that still target the pre-0.8 proposal queue and indexing workflow.
2. Prefer `akm improve` for the main refinement/maintenance workflow.
3. Stop calling `akm index --enrich`; use plain `akm index` plus `akm improve` maintenance flows.
4. Use `akm health --since 24h` after upgrade to confirm state-db and task-history health.
5. Rename proposal queue commands as per the table above.
6. Review task definitions for Windows path compatibility if using absolute paths.

No manual data migration is required. The proposal queue and existing stash assets remain compatible.

## Try the New Surfaces

```sh
# Generate a new memory asset as a proposal
akm improve memory my-new-notes --task "Summarize today's debugging session"

# List improvement proposals
akm proposals

# Show one proposal
akm show proposal <id>

# Accept a proposal (after review)
akm accept <id>

# Define and run a task
akm task run daily-code-review
```

## Verification

After upgrading:
```sh
akm info --format text     # version 0.8.x
akm health --since 24h     # runtime + improve telemetry checks
akm proposals              # queue starts empty — that's expected
akm task list              # shows your defined tasks
```

Full details in the [v1 migration guide](../migration/v1.md) and the [0.8.0 release notes](../migration/release-notes/0.8.0.md).

Full changelog at [CHANGELOG.md](https://github.com/itlackey/akm/blob/main/.github/CHANGELOG.md).
