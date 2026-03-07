---
description: Search the Agentikit stash for tools, skills, commands, and agents using semantic search
---

Search the Agentikit stash using the CLI. If a search index exists, results are ranked by semantic relevance. Run `agentikit index` first to enable semantic search.

```bash
agentikit search $ARGUMENTS
```

Parse the JSON output and present the results to the user in a readable format. Include the `openRef` for each hit so the user can open or run assets. Results may include `description`, `tags`, and `score` fields when semantic search is active.
