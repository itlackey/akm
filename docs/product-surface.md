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

## Capture

- [Remember, import, clone](guides/capture-knowledge.md). *Stable*; `clone` is Deprecated (use `akm import <ref> --asset-ref`) and removed in 0.11
- Feedback: rate an asset or attach a fix. *Stable*
- Lessons. *Experimental*

## Improve

- [`akm improve` and proposals](guides/improve-the-library.md): reviewable changes from feedback and usage. *Evolving*
- Improve settings and strategies other than `default` and `consolidate`. *Experimental*
- Automatic acceptance by the triage judgment tier (opt-in): `experimental.improveAutonomy` with `processes.triage.judgment` on. The `default` strategy's triage accepts proposals a quality judge passed without it. *Experimental*
- `akm proposal drain --promote`: accept the proposals a quality judge passed. *Evolving*
- Session extraction. *Evolving*
- `akm rules`: the rules that apply in a project. *Experimental*

## Monitor

- `akm doctor` (health, info, log, prompt, judge, scheduler, explain). *Evolving*
- `akm doctor metrics`: report content is *Experimental*; `doctor metrics usage --export` is stable. `akm health`, `metrics`, `info` and `log` are Deprecated, removed in 0.11
- Lint. *Evolving*

## Run work

- [Tasks and scheduling](guides/scheduling.md). *Evolving*
- Task source v5 (`version: 5-beta.1`) and `akm exec` (off until `experimental.exec`). *Experimental*
- [Workflows](guides/run-workflows.md). *Deprecated*, removed in 0.11 (tasks with ordered steps replace them)
- Agent dispatch (`akm run` on agent and command refs) and harnesses (Claude Code, Codex, OpenCode and others). *Evolving*
- Model aliases (`akm models`). *Evolving*

## Environment and secrets

- [Read and inject](reference/env-and-secrets.md). *Stable*
- Create and change. *Experimental*

## Setup and maintenance

- Install, setup, info, config, help, completions. *Stable*
- Upgrade, including agent plugins and `--channel`. *Stable*; `--next` is Deprecated
