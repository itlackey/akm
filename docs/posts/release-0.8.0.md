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

akm 0.8.0 is out. This release focuses on refining the agent interaction model: the self-improvement CLI has been replaced with a more flexible `improve` command, task assets now enable persistent, long-running agent workflows, and belief-aware memory ensures stash updates are grounded in the agent's current beliefs about the world.

If you are on 0.7.x, the v1 migration guide covers the per-surface delta. The upgrade requires updating scripts and agent instructions due to breaking CLI changes.

## TL;DR

- **`akm improve`** — unified command for agent-driven asset refinement, replacing `reflect` and `distill`.
- **Task assets** — first-class asset type for defining persistent agent workflows with scheduling, triggers, and context.
- **Belief-aware memory** — stash updates now incorporate the agent's belief state to prevent overwriting correct information.
- **Proposal queue commands renamed** — `akm proposals` (list), `akm show proposal`, `akm diff proposal`, `akm accept`, `akm reject`.
- **CLI breaking changes** — old `reflect`, `distill`, and `akm proposal *` commands are removed; update your automation.
- **Security and hygiene** — Windows task path parsing fixed, cron apostrophe escaping stabilized, flaky tests addressed.

---

## `akm improve`: The New Self-Improvement Surface

The `akm improve` command consolidates asset refinement workflows. It can operate on a specific asset type (generating a new asset) or an existing asset ref (refining that asset). Under the hood, it uses the same proposal queue as before, ensuring all changes are reviewable before promotion.

```sh
akm improve <type> <name>          # generate a new asset of type <type> named <name> as a proposal
akm improve <ref>                  # refine an existing asset and produce a proposal
```

This replaces the previous `akm propose <type> <name> --task "..."` and `akm reflect <ref>` workflows. The `--task` flag is now replaced by providing task context via the asset's definition or through interactive refinement.

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

## Migration Guidance

Breaking changes in 0.8.0:
- Removed: `akm reflect`, `akm distill`, `akm proposal *` (all subcommands)
- Added: `akm improve`, task assets, renamed proposal commands
- Windows task path parsing now correctly handles absolute paths and drive letters
- Cron expressions with apostrophes are now properly escaped in schtasks XML

To upgrade:
1. Update any scripts or automation that use the removed commands.
2. Replace `akm reflect` and `akm distill` with `akm improve` workflows.
3. Rename proposal queue commands as per the table above.
4. Review task definitions for Windows path compatibility if using absolute paths.

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
akm proposals              # queue starts empty — that's expected
akm task list              # shows your defined tasks
```

Full details in the [v1 migration guide](../migration/v1.md) and the [0.8.0 release notes](../migration/release-notes/0.8.0.md).

Full changelog at [CHANGELOG.md](https://github.com/itlackey/akm/blob/main/.github/CHANGELOG.md).