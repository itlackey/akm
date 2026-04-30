---
description: "Scaffold and start the combined topic-swarm plus deep-research workflow with a clean parameter template."
---
# Start Topic Swarm Deep Research

Start the combined swarm-plus-deep-research workflow for this goal:

`$ARGUMENTS`

Use this procedure:

1. Ensure the workflow asset exists in the stash. If `workflow:research/topic-swarm-select-and-deep-research` does not exist yet, create it from `docs/example-stash/workflows/topic-swarm-select-and-deep-research.md`:

```sh
akm workflow create research/topic-swarm-select-and-deep-research --from docs/example-stash/workflows/topic-swarm-select-and-deep-research.md
```

2. Start the workflow with a clean parameter template. Fill in unknowns conservatively instead of inventing specifics:

```json
{
  "goal": "$ARGUMENTS",
  "audience": "Specify the intended reader and decision-maker",
  "scope": "Specify boundaries, exclusions, geography, time horizon, and quality bar",
  "workspace_dir": ".akm-run/topic-swarm-deep-research",
  "deliverable_path": ".akm-run/topic-swarm-deep-research/report.md",
  "wiki_name": "research",
  "max_swarm_topics": "12",
  "max_topic_depth": "3",
  "max_topic_branches": "5",
  "max_iterations": "8",
  "min_primary_sources": "5",
  "trusted_domains": "[]",
  "seed_urls": "[]"
}
```

3. Start the run:

```sh
akm workflow start workflow:research/topic-swarm-select-and-deep-research --params '<paste-the-json-template-after-filling-it>'
```

4. Immediately inspect the first actionable step:

```sh
akm workflow next workflow:research/topic-swarm-select-and-deep-research
```

5. Record the returned run id and continue the run step by step. If the goal is already narrow and topic selection is unnecessary, prefer the standalone workflow in `docs/example-stash/workflows/deep-research-auto-research.md` instead.
