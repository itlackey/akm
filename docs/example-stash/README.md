# Example Stash

This directory is a documentation-backed example stash that shows how different
AKM asset types fit together.

Current layout:

```text
docs/example-stash/
  commands/    # command prompt templates that help launch workflows
  workflows/   # resumable multi-step procedures
```

## When To Use What

- Use `commands/` when you want a reusable entrypoint that gives an agent or
  operator a fast, repeatable way to launch a task with a clean template.
- Use `workflows/` when the task is multi-step, stateful, resumable, or needs a
  durable audit trail.

In this example stash:

- `commands/start-topic-swarm-deep-research.md` is the entrypoint for kicking
  off the combined swarm-to-deep-research flow.
- `workflows/deep-research-auto-research.md` is the focused workflow for one
  already-chosen topic.
- `workflows/topic-swarm-select-and-deep-research.md` is the broader workflow
  that explores many candidate topics, selects the best one, and then transitions
  into deep research.
- `workflows/blog-publish-article.md` is a long-form editorial workflow with
  multi-reviewer gates.
- `workflows/github-issues-parallel-implementer.md` shows multi-agent parallel
  implementation across isolated worktrees.

### Common-task workflows

Smaller, repeatable workflows that double as templates for everyday
engineering work:

- `workflows/triage-bug-report.md` — intake, reproduce, localize, propose a
  fix, and promote durable lessons back into the stash and a knowledge wiki.
- `workflows/weekly-dependency-audit.md` — recurring lockfile audit that
  ships safe upgrades and queues the rest, demonstrating `akm vault` for
  registry credentials.
- `workflows/code-review-pr.md` — structured PR review against the project's
  own conventions, demonstrating `akm search` for prior art and
  `akm feedback` to signal reviewer-persona quality.
- `workflows/ship-feature-from-spec.md` — spec-to-PR delivery loop with
  test-first discipline and ADR-style decision capture.

### Nested workflow example

- `workflows/release-train.md` is an **orchestrator** that delegates to
  other workflows in this stash as nested runs:
  - `workflow:weekly-dependency-audit` for pre-flight maintenance
  - `workflow:code-review-pr` once per release-blocker PR
  - `workflow:release-retrospective` (sibling, to be created) for the
    post-release learning loop

  Each nested run has its own `runId`, can be inspected with
  `akm workflow status`, and can be resumed independently if interrupted.
  The orchestrator only owns the cross-cutting artefacts (release book,
  changelog, tag, deploy, announcement) — the heavy lifting lives in
  small, individually testable workflows.

## Suggested Flow

1. If the problem is still broad or you need topic discovery, start with the
   command in `commands/`.
2. That command creates or starts the combined workflow in `workflows/`.
3. If the topic is already known, skip the swarm and start the standalone
   deep-research workflow directly.
4. For routine engineering work, pick the common-task workflow that matches
   the job — bug, dep audit, review, feature — instead of running the
   full research stack.
5. For a release, run `workflow:release-train` and let it spawn the nested
   runs it needs.

As this example stash grows, it can hold more asset types without overloading
the generic `docs/examples/` namespace.
