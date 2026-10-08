# Product Surface

A map of everything akm does, with a short description and the status of each
feature. Use it to see what akm offers and how settled each part is. Follow
the links for the details.

**Status** follows the [stability policy](../STABILITY.md):

| Status | What it means for you |
| --- | --- |
| **Stable** | Safe to build on and script against. Breaking changes only happen at a minor version, with notice. |
| **Evolving** | Ready to use. Details such as output fields or flags may still change between releases. |
| **Experimental** | Try it, but don't depend on it. It may change a lot or be removed. |

> [!NOTE]
> akm is in its 0.9 series. The 0.10 series stabilizes the product: by its end,
> every feature below is either Stable or removed. Experimental features are the
> ones most likely to change.

---

## Get started

| Feature | What it does | Status |
| --- | --- | --- |
| **Install and setup** | Install from npm or as a standalone binary, then `akm setup` walks you through a first configuration. | Stable |
| **Upgrade** | `akm upgrade` updates akm in place. It also updates the akm plugin of the coding agents you have installed (Claude Code, Codex, OpenCode), and `--next` follows prerelease builds. | Evolving |
| **Help for people and agents** | `akm help` for you; `akm hints` (or `akm help agents`) gives a coding agent the guide it needs to use akm. | Stable |
| **Configuration** | `akm config` reads and changes settings; `akm info` shows where akm keeps its files. | Stable |
| **Shell completions** | `akm completions` for your shell. | Stable |

> [!TIP]
> Updating the agent plugins and `--next` are new in 0.9.28. They become Stable
> once they have been verified on real installs, before the 0.9 series ends.

Learn more: [Getting Started](guides/getting-started.md),
[Concepts](guides/concepts.md), [Agent install](agents/agent-install.md),
[Configuration](reference/configuration.md).

---

## Your library

akm keeps one library of agent capabilities that every coding agent can use.

| Feature | What it does | Status |
| --- | --- | --- |
| **Bundles** | Add, list, update and remove the sources your library draws from: local folders, git repos, npm packages and websites. | Stable |
| **Native akm bundles** | akm's own format, with full read and write: skills, commands, agents, scripts, workflows, knowledge, memories, tasks and more. | Stable |
| **Existing agent folders** | Claude Code and OpenCode folders and Agent Skills packages are read where they are, without converting them. | Evolving |
| **Website sources** | Snapshot a website into a searchable bundle. | Evolving |
| **Wikis and plain-markdown knowledge** | Karpathy-style LLM wikis and OKF knowledge bases, plus generic files. | Evolving |
| **Registries** | Discover bundles others publish; search them alongside your own. | Evolving |
| **Sync** | `akm sync` commits the changes in a git-backed bundle, and pushes them when the bundle has a remote. | Stable |

> [!NOTE]
> Bundles you add from elsewhere are read-only. akm only writes to bundles you
> own, and every change it proposes is reviewable.

Learn more: [Bundles](guides/bundles.md),
[Supported formats](reference/supported-formats.md),
[Asset types](reference/asset-types.md), [Wikis](guides/wikis.md),
[Website sources](reference/website-sources.md),
[Registry](reference/registry.md), [Refs](reference/refs.md).

---

## Find and load

| Feature | What it does | Status |
| --- | --- | --- |
| **Search** | Find assets across every bundle by keyword and meaning. | Stable |
| **Curate** | Get a short, ranked list of the assets that best fit a task. | Stable |
| **Show** | Load one asset by its ref, so an agent reads only what the task needs. | Stable |
| **Related assets** | Results point to the assets they link to, so an agent can follow a topic. | Evolving |
| **Agent-shaped output** | `--shape agent` trims output to what an agent needs. | Experimental |

Learn more: [Discover and load](guides/discover-and-load.md),
[Use akm with any agent](guides/use-with-any-agent.md).

---

## Capture what you learn

| Feature | What it does | Status |
| --- | --- | --- |
| **Remember** | Save a memory from a session or a note. | Stable |
| **Import and clone** | Bring a document into your library, or copy an asset from another bundle to edit. | Stable |
| **Feedback** | Mark an asset as helpful, or wrong or out of date, and attach an exact fix. Feedback improves ranking and drives improvements. | Stable |
| **Lessons** | Short, reusable rules distilled from memories. | Experimental |

Learn more: [Capture knowledge](guides/capture-knowledge.md),
[Memory](reference/memory.md).

---

## Improve the library

akm can review its own library and propose improvements from your feedback and
usage.

| Feature | What it does | Status |
| --- | --- | --- |
| **`akm improve`** | Runs the improvement processes on your library, on demand or on a schedule. | Evolving |
| **Proposals** | Every change is a proposal you can show, diff, accept, reject or revert. | Evolving |
| **Improvement processes** | Reflect (fixes notes from feedback), distill (turns memories into lessons), consolidate (promotes memories to knowledge and removes duplicates), memory inference. | Evolving, settings Experimental |
| **Strategies** | Named presets for which processes run and how. `default` and `consolidate` are the main ones. | Evolving; others Experimental |
| **Automatic acceptance** | Lets a judge model accept safe proposals without you. Off unless you turn it on. | Experimental |
| **Session extraction** | Pulls lessons out of your coding-agent sessions. | Experimental |

> [!IMPORTANT]
> akm never changes your library silently by default: improvements arrive as
> proposals for you to review. Automatic acceptance is opt-in.

> [!NOTE]
> The 0.10 series measures every improvement process and setting, then ships the
> configuration that works best as the default. Strategies and settings marked
> Experimental may be folded together or removed along the way.

Learn more: [Improve the library](guides/improve-the-library.md),
[Configuration: strategies](reference/configuration.md).

---

## Check how it's doing

| Feature | What it does | Status |
| --- | --- | --- |
| **Health** | `akm health` checks that akm and its improvement runs are working, and can produce a report. | Evolving; report content Experimental |
| **Metrics** | `akm metrics` shows what akm has recorded: what was searched and used, feedback, model usage, tasks and proposals, with an HTML dashboard. | Experimental |
| **Log** | `akm log` shows akm's event history. | Evolving |
| **Lint** | `akm lint` checks your assets for problems. | Evolving |

> [!NOTE]
> akm is local-first. It keeps its data on your machine and sends nothing home.
> The metrics dashboard contains the text of your searches, so keep it local.

Learn more: [CLI: health](reference/cli.md#health),
[CLI: metrics](reference/cli.md#metrics),
[Data and telemetry](reference/data-and-telemetry.md).

---

## Run work

| Feature | What it does | Status |
| --- | --- | --- |
| **Tasks and scheduling** | Schedule akm commands and agent prompts through your system's scheduler (cron, launchd, Task Scheduler). | Evolving |
| **Workflows** | Multi-step procedures that run step by step and can resume. | Experimental |
| **Agent dispatch** | `akm agent` and `akm command run` hand a prompt or a stored command to a coding agent. | Evolving |
| **Agent harnesses** | The coding agents akm can drive: Claude Code, Codex and OpenCode (through its SDK) first, plus Copilot, Gemini, Aider, Amazon Q, OpenHands and Pi. | Evolving |
| **Model aliases** | `akm models` lists and customizes the names akm uses for models. | Evolving |

> [!WARNING]
> Workflows are Experimental through the 0.10 series: the series decides
> whether they are stabilized or removed. Don't build anything critical on them
> yet.

Learn more: [Scheduling](guides/scheduling.md), [Tasks](reference/tasks.md),
[Run workflows](guides/run-workflows.md),
[Writing workflows](guides/author-workflows.md),
[CLI: agent](reference/cli.md#agent).

---

## Environment and secrets

| Feature | What it does | Status |
| --- | --- | --- |
| **Use env files and secrets** | List them and inject them into a command (`akm env run`, `akm secret run`) without printing their values. | Stable |
| **Create and change them** | Write env files and secrets through akm. | Experimental |

> [!IMPORTANT]
> Secret values are never printed, indexed or written to akm's output. Use
> `akm env run` or `akm secret run` to pass them to a command.

Learn more: [Environment and secrets](reference/env-and-secrets.md).

---

## Build on akm

| Feature | What it does | Status |
| --- | --- | --- |
| **Author and share bundles** | Package your own capabilities so others can install them. | Stable |
| **Ship akm inside a product** | A documented contract for bundling akm in another tool. | Evolving |
| **Agent plugins** | Plugins for Claude Code, Codex and OpenCode that wire akm into each agent ([akm-plugins](https://github.com/itlackey/akm-plugins)). | Evolving |

Learn more: [Bundle author's guide](guides/author-bundles.md),
[Bundling akm](integration/bundling-akm.md).

---

For every command and flag, see the [CLI reference](reference/cli.md). For the
exact stability of each command, see [STABILITY.md](../STABILITY.md).
