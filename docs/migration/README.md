# Migration

Upgrade guides and per-release migration notes.

- [v0.9.1 -> v0.9.2 migration guide](v0.9.1-to-v0.9.2.md) -- Task-v2/task-v3 to task source v4 conversion, the durable-v4-family workflow boundary at executable `irVersion: 5`, and release behavior changes
- [v0.9.2 release note](release-notes/0.9.2.md) -- Self-contained terminal upgrade summary shipped for `akm help migrate 0.9.2`
- [v0.9.16 release note](release-notes/0.9.16.md) -- Source-bound scheduler grants, local execution authority, and split unsafe overrides
- [v0.9.17 release note](release-notes/0.9.17.md) -- Consolidate's retire proposals and index layout 26, replacing the LLM entity graph with declared links, and `akm improve` scoped to what retrieval actually returns
- [v0.9.19 release note](release-notes/0.9.19.md) -- `akm improve` scoped to the bundle it writes to (scheduled runs need one `--bundle` run per other bundle), `akm proposal reopen` and the retire-proposal diff, and fewer repeat consolidate promotions
- [v0.8 -> current v0.9 migration guide](v0.8-to-v0.9.md) -- Package upgrade with fresh current config/state and explicit task conversion
- [v0.7 -> v0.8 migration guide](v0.7-to-v0.8.md) -- Task schema and 0.8-era changes
- [v0.5 -> v0.6 migration guide](v0.5-to-v0.6.md) -- Terminology cut, registry schema v3, publisher changes
- [Release notes index](release-notes/README.md) -- The short per-release notes `akm help migrate <version>` prints, with links to every bundled note
