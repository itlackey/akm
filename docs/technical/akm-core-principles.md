# akm Core Principles

akm is apt for agents. A human searches apt for the right software; an agent searches akm for the right skill. Everything flows from this.

## What akm Does

An agent has a task. Somewhere across local directories, installed kits, and remote registries, there's a script, skill, command, agent definition, or knowledge document that helps. akm finds it and delivers just enough information for the agent to use it -- without the human copying files around or the agent drowning in context.

Three operations, one pipeline:

```
search --> show --> use
```

Search returns a menu. Show returns a payload. The agent uses the payload. That's it.

## The apt Analogy

akm mirrors the Debian apt model with four layers:

| apt concept | akm equivalent | What it does |
| --- | --- | --- |
| `/etc/apt/sources.list` | `registries` in config | Lists where to find packages/kits |
| package repository | registry (static JSON index) | Curated or self-hosted catalog of available kits |
| `apt install nginx` | `akm add npm:@scope/kit` | Installs a kit and indexes its assets |
| `dpkg -L nginx` | `akm show script:deploy.sh` | Inspects what's inside |
| `/usr/bin/nginx` | asset in stash directory | The installed capability, ready to use |
| `apt search` | `akm search` | Discovers capabilities by keyword |
| `apt update` | `akm update --all` | Refreshes installed kits to latest versions |

The layers map cleanly:

1. **Registries** are `sources.list` -- indexes of what's available. The official registry ships by default; add third-party ones with `akm registry add`.
2. **Kits** are packages -- installable bundles of assets. Install with `akm add`, remove with `akm remove`, update with `akm update`. Installed kits are cached separately in `~/.cache/akm/`, managed by akm.
3. **Stashes** are the local directories you own -- your working stash (`~/akm`) plus any additional stashes registered via `akm stash add`. Think of them like `/usr/local/bin` (your stuff) alongside `/usr/bin` (system packages).
4. **Assets** are the individual programs/files -- the scripts, skills, commands, agents, and knowledge documents an agent discovers and uses.

Search merges stashes and installed kits into one searchable collection, just as `$PATH` merges multiple directories.

## The Rules

### 1. Every token must earn its place

The context window is the scarce resource. Every field in search output, every line in a show response, every piece of metadata costs tokens. If a field doesn't help the agent decide (search) or act (show), it doesn't ship.

Ask: "Would removing this field cause the agent to make a worse decision or fail to use the asset?" If no, remove it.

### 2. Search is a menu, not a report

Search results exist for one purpose: help the agent pick which asset to load. A hit needs a name, a description, a type, a size hint, a ref to pass to show, and an action telling the agent what to do next. That's a menu item. Anything beyond that -- scores, match explanations, filesystem paths, edit permissions -- is debug information that belongs behind a flag, not in the default output.

### 3. Show is a dispatch envelope

Show delivers exactly what the agent needs to use the asset. A script gets a run command, setup step, and working directory. A skill gets its full instructions. An agent definition gets its prompt, model hint, and tool policy. Nothing more.

Show does not explain how akm works. Show does not include administrative metadata the agent can't act on. Show delivers a payload the agent executes, follows, or dispatches.

### 4. Progressive disclosure, not progressive accumulation

Three layers, clean boundaries:

| Layer | What the agent sees | Purpose |
| --- | --- | --- |
| Search | Name, type, description, action, ref | Decide which asset to load |
| Show | Full payload for the chosen asset | Act on the asset |
| Filesystem | Linked files, scripts, references inside a skill | Go deeper only if needed |

Information flows down, never up. Search never contains show-level detail. Show never forces the agent to read linked files it doesn't need. Each layer is complete for its purpose.

### 5. Registries are catalogs, stashes are local, kits are packages

This maps cleanly to the apt model. Registries list what's available. `akm add` installs a kit into a local cache directory. `akm remove` reverses this. `akm update` refreshes installed kits. Stashes are directories you own — your working stash plus any extras. The agent doesn't know or care whether an asset comes from a stash or an installed kit — it searches, it shows, it uses.

Users can add any npm package, GitHub repo, git URL, or local directory as a kit source. They can add third-party registries for team or community discovery.

### 6. The ref is plumbing, not porcelain

The `type:name` ref string is a lookup handle. Agents get it from search, pass it to show, and never parse it. Humans shouldn't need to construct refs by hand. Don't add features that require understanding the ref format. Don't encode metadata in refs that's already available as structured fields.

### 7. Output format serves the consumer

The default consumer is an LLM reading JSON from stdout. Default to JSON, default to brief detail. Humans who want richer output opt in with `--detail normal`, `--detail full`, or `--format text|yaml`. Never design output for humans first and hope agents can parse it.

### 8. If it doesn't touch search, show, or stash management, question it hard

The feature checklist:

- Does it help agents **find** the right asset? --> search improvement, indexing, metadata quality
- Does it help agents **use** an asset? --> show output, action field, payload format
- Does it help users **manage** their stashes and kits? --> add, remove, update, clone, stash, config
- Does it help kit makers **publish** assets? --> registry, indexing, metadata authoring

If a proposed feature doesn't fit one of these four categories, it probably doesn't belong in akm. Features that sound useful in the abstract but don't serve the search-->show-->use pipeline are how tools become bloated.

### 9. Agents are intelligent; treat them that way

Don't over-explain. Don't repeat boilerplate usage instructions on every search result. Don't hardcode compliance preambles into prompt payloads. Give the agent a clear `action` field and trust it to follow through. The agent is the senior engineer reading the package description -- not a junior who needs the README pasted into every search result.

### 10. Simple things stay simple

`akm search "deploy"` should always work, return results fast, and cost minimal tokens. `akm show script:deploy.sh` should return the run command and nothing the agent didn't ask for. Complexity lives in the indexer, the registry resolver, and the config system -- never in the hot path between the agent and its next action.

## What akm Does Not Do

- **Execute assets.** akm finds and describes. The agent (or its runtime) executes.
- **Manage agent state.** akm doesn't track which assets an agent has used, which sessions are active, or what happened after show.
- **Replace MCP.** akm is complementary. MCP connects agents to live services. akm discovers static capabilities. They solve different problems.
- **Version assets at the ref level.** Versions are resolved at the stash layer (npm semver, git tags, filesystem state). The agent never sees a version -- it sees whatever is installed.
- **Provide a UI.** akm is a CLI that produces structured output. Any UI is a consumer of that output, not part of akm itself.
