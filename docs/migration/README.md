# Migration

Upgrade guides and per-release migration notes.

## Current

- [v0.9 -> v0.10 migration guide](v0.9-to-v0.10.md) -- Upgrade order for a 0.9.15+ install, every removed CLI spelling, strategy, config key and workflow feature with its replacement, changed `akm improve` defaults, the OpenCode plugins, and `0.10.YYMMNN` version numbers
- [v0.10.0 release note](release-notes/0.10.0.md) -- Summary of the 0.10 series: the 0.9.15 version floor, `--shape`/`--target`/`help agents` removals, `default` and `consolidate` as the only built-in strategies, OpenCode 2, feedback-scaled ranking, and what is gone
- [Release notes index](release-notes/README.md) -- The short per-release notes `akm help migrate <version>` prints, with links to every bundled note

## Historical

Guides and notes for earlier releases. They describe the commands and formats of
their own release, which the current CLI may no longer have, and are not checked
against it.

- [v0.9.1 -> v0.9.2 migration guide](v0.9.1-to-v0.9.2.md) -- Task-v2/task-v3 to task source v4 conversion, the workflow plan format change, and release behavior changes
- [v0.9.2 release note](release-notes/0.9.2.md) -- Self-contained terminal upgrade summary shipped for `akm help migrate 0.9.2`
- [v0.9.16 release note](release-notes/0.9.16.md) -- Source-bound scheduler grants, local execution authority, and split unsafe overrides
- [v0.9.17 release note](release-notes/0.9.17.md) -- Consolidate's retire proposals and index layout 26, replacing the LLM entity graph with declared links, and `akm improve` scoped to what retrieval actually returns
- [v0.9.19 release note](release-notes/0.9.19.md) -- `akm improve` scoped to the bundle it writes to (scheduled runs need one `--bundle` run per other bundle), `akm proposal reopen` and the retire-proposal diff, and fewer repeat consolidate promotions
- [v0.8 -> current v0.9 migration guide](v0.8-to-v0.9.md) -- Package upgrade with fresh current config/state and explicit task conversion
- [0.9 upgrade troubleshooting](v0.9.0-troubleshooting.md) -- When `akm upgrade` succeeded but akm rejects the config, a database will not open, task migration is blocked, or a workflow will not resume
