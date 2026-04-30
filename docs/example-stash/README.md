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

## Suggested Flow

1. If the problem is still broad or you need topic discovery, start with the
   command in `commands/`.
2. That command creates or starts the combined workflow in `workflows/`.
3. If the topic is already known, skip the swarm and start the standalone
   deep-research workflow directly.

As this example stash grows, it can hold more asset types without overloading
the generic `docs/examples/` namespace.
