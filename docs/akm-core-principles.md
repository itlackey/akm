# akm Core Principles

akm is apt for agents. A human searches apt for the right software; an agent searches akm for the right skill. Everything flows from this.

## What akm Does

An agent has a task. Somewhere across local directories, installed kits, and remote registries, there's a script, skill, command, agent definition, or knowledge document that helps. akm finds it and delivers just enough information for the agent to use it — without the human copying files around or the agent drowning in context.

Three operations, one pipeline:

```
search → show → use
```

Search returns a menu. Show returns a payload. The agent uses the payload. That's it.

## The Rules

### 1. Every token must earn its place

The context window is the scarce resource. Every field in search output, every line in a show response, every piece of metadata costs tokens. If a field doesn't help the agent decide (search) or act (show), it doesn't ship.

Ask: "Would removing this field cause the agent to make a worse decision or fail to use the asset?" If no, remove it.

### 2. Search is a menu, not a report

Search results exist for one purpose: help the agent pick which asset to load. A hit needs a name, a description, a type, a size hint, a ref to pass to show, and an action telling the agent what to do next. That's a menu item. Anything beyond that — scores, match explanations, filesystem paths, edit permissions — is debug information that belongs behind a flag, not in the default output.

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

### 5. Stashes are sources, kits are packages

This is the apt model:

| apt concept | akm equivalent |
| --- | --- |
| `/etc/apt/sources.list` | `searchPaths` in config |
| `apt install nginx` | `akm add npm:@scope/kit` |
| package repository | akm registry |
| `/usr/bin/nginx` | asset in stash directory |
| `apt search` | `akm search` |
| `dpkg -L nginx` | `akm show` |

A stash is a directory of assets. Local directories, installed kit directories, and remote packages all become stash sources. The agent doesn't know or care whether an asset is local or installed — it searches, it shows, it uses.

`akm add` installs a kit from a registry source into a local cache directory and adds it to the search path. `akm remove` reverses this. `akm update` refreshes installed kits. The akm-registry provides a curated index of known-good sources. Users can add any npm package, GitHub repo, or local directory as a source.

### 6. The ref is plumbing, not porcelain

The `type:name` ref string is an opaque handle. Agents get it from search, pass it to show, and never parse it. Humans shouldn't need to construct refs by hand. Don't add features that require understanding the ref format. Don't encode metadata in refs that's already available as structured fields.

### 7. Output format serves the consumer

The default consumer is an LLM reading JSON from stdout. Default to JSON, default to brief detail. Humans who want richer output opt in with `--detail normal`, `--detail full`, or `--format text|yaml`. Never design output for humans first and hope agents can parse it.

### 8. If it doesn't touch search, show, or stash management, question it hard

The feature checklist:

- Does it help agents **find** the right asset? → search improvement, indexing, metadata quality
- Does it help agents **use** an asset? → show output, action field, payload format
- Does it help users **manage** their stashes? → add, remove, update, clone, sources, config
- Does it help kit makers **publish** assets? → registry, indexing, metadata authoring

If a proposed feature doesn't fit one of these four categories, it probably doesn't belong in akm. Features that sound useful in the abstract but don't serve the search→show→use pipeline are how tools become bloated.

### 9. Agents are intelligent; treat them that way

Don't over-explain. Don't repeat boilerplate usage instructions on every search result. Don't hardcode compliance preambles into prompt payloads. Give the agent a clear `action` field and trust it to follow through. The agent is the senior engineer reading the package description — not a junior who needs the README pasted into every search result.

### 10. Simple things stay simple

`akm search "deploy"` should always work, return results fast, and cost minimal tokens. `akm show script:deploy.sh` should return the run command and nothing the agent didn't ask for. Complexity lives in the indexer, the registry resolver, and the config system — never in the hot path between the agent and its next action.

## What akm Does Not Do

- **Execute assets.** akm finds and describes. The agent (or its runtime) executes.
- **Manage agent state.** akm doesn't track which assets an agent has used, which sessions are active, or what happened after show.
- **Replace MCP.** akm is complementary. MCP connects agents to live services. akm discovers static capabilities. They solve different problems.
- **Version assets at the ref level.** Versions are resolved at the stash layer (npm semver, git tags, filesystem state). The agent never sees a version — it sees whatever is installed.
- **Provide a UI.** akm is a CLI that produces structured output. Any UI is a consumer of that output, not part of akm itself.
