# akm Core Principles

akm exists to help agents find the right asset, load the right payload, and use
it with minimal context overhead.

## What akm Does

An agent has a task. Across configured sources (local filesystem paths and
cache-backed git/website/npm mirrors) and registry catalogs, akm helps it
discover assets such as scripts, skills, commands, agents, knowledge docs,
workflows, vaults, and wiki pages.

Core flow:

```text
search -> show -> use
```

## Principles

### 1. Every token must earn its place

Default output should stay lean. Search is for choosing; show is for using.

### 2. Search is a menu

Default search output should expose only enough to choose the next asset. In the
current CLI that usually means:

- `brief`: `type`, `name`, `action`, `estimatedTokens`
- `normal`: adds `description` and `score`
- `agent` (0.6.0+; `--for-agent` is the deprecated alias): includes `ref`

Richer provenance/debug fields belong behind fuller detail modes.

### 3. Show is a dispatch envelope

Show should return the payload that lets the consumer act:

- script execution hints
- skill instructions
- command templates
- agent prompts
- knowledge/wiki content
- workflow steps and parameters
- vault key names without secret values

### 4. Progressive disclosure

Search should not accumulate show-level detail. `full` detail modes can expose
more metadata, but the base mental model stays:

```text
search decides
show delivers
filesystem is optional depth
```

### 5. Registries and sources stay conceptually separate

- registries are read-only catalogs of installable kits
- sources are locally indexed directories (filesystem, or cache-backed
  git/website/npm mirrors)
- registry results live in `registryHits`, never merged into source `hits`

### 6. Refs are plumbing

Consumers should treat refs as opaque lookup handles. The current wire format is
`[origin//]type:name`, but agents should pass refs through rather than parse
them.

### 7. Output serves agents first

The default consumer is structured-output automation. JSON-first and concise
detail levels are the right defaults.

### 8. Complexity belongs behind indexing and source management

The hard parts should stay inside indexing, source resolution, registry
install, and provider plumbing, not in the hot path from `search` to `show`.

## What akm Does Not Do

- execute assets itself
- expose vault secret values through `show`
- replace live-service integrations such as MCP
- require agents to understand source layouts or provider internals
