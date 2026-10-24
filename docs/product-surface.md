# Product Surface

Every akm feature, with its status. Status meanings, and the status of every
command, are in [STABILITY.md](../STABILITY.md).

> [!NOTE]
> Experimental features may change or be removed in the 0.10 series; STABILITY.md
> says what is planned for each.

## Library

- [Bundles](guides/bundles.md): add local folders, git repos, npm packages and websites. *Stable*
- [Supported formats](reference/supported-formats.md): akm bundles, Claude Code and OpenCode folders, Agent Skills, wikis, websites. *Evolving*
- [Registries](reference/registry.md): find bundles others publish. *Evolving*
- Sync: commit and push a git-backed bundle. *Stable*

## Find and load

- [Search, curate, show](guides/discover-and-load.md): find assets and load one by ref. *Stable*
- Agent and summary output shapes (`--shape agent`, `--shape summary`). *Experimental*

## Capture

- [Remember, import, clone](guides/capture-knowledge.md). *Stable*
- Feedback: rate an asset or attach a fix. *Stable*
- Lessons. *Experimental*

## Improve

- [`akm improve` and proposals](guides/improve-the-library.md): reviewable changes from feedback and usage. *Evolving*
- Improve settings and strategies other than `default` and `consolidate`. *Experimental*
- Automatic acceptance (opt-in): `experimental.improveAutonomy` together with a triage `applyMode: "promote"` strategy. *Experimental*
- `akm proposal drain --promote`: accept the proposals a quality judge passed. *Evolving*
- Session extraction. *Experimental*

## Monitor

- Health. *Evolving*
- Metrics. *Experimental*
- Log, lint. *Evolving*

## Run work

- [Tasks and scheduling](guides/scheduling.md). *Evolving*
- [Workflows](guides/run-workflows.md). *Experimental*
- Agent dispatch (`akm agent`, `akm command run`) and harnesses (Claude Code, Codex, OpenCode and others). *Evolving*
- Model aliases (`akm models`). *Evolving*

## Environment and secrets

- [Read and inject](reference/env-and-secrets.md). *Stable*
- Create and change. *Experimental*

## Setup and maintenance

- Install, setup, info, config, help, completions. *Stable*
- Upgrade, including agent plugins and `--next`. *Stable*
