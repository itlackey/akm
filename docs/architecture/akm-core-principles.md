# akm Core Principles

akm is a portable capability library for AI agents — give every coding agent
the capabilities your team has already built. It indexes existing agent
assets in place, loads only what a task needs, packages capabilities into
shareable bundles, improves the library through reviewable proposals, and
runs durable workflows, locally and without tying the library to one
assistant.

This document lists the design constraints that keep that library
predictable.

## What akm Does

An agent has a task. Across configured sources (local filesystem paths and
cache-backed git/website/npm mirrors) and registry catalogs, akm helps it
discover assets such as scripts, skills, commands, agents, knowledge docs,
workflows, env files, secrets, and wiki pages.

Core flow:

```text
connect -> index -> curate -> show -> use/run -> feedback -> proposal
```

Not every task uses every stage.

## Principles

### 1. Capabilities remain portable files

Capabilities are ordinary files on disk — skills, scripts, workflows, agent
definitions, instructions, memories, knowledge docs. akm indexes what's
already there; the source files remain the source of truth, and akm's index
is a derived, rebuildable view rather than a copy of record.

### 2. Materialize sources locally and use one retrieval layer

Local filesystem paths and cache-backed git/website/npm mirrors all
materialize into one local index, so `search`, `curate`, and `show` work the
same way regardless of where a capability originated. Registries stay a
conceptually separate, read-only catalog of installable bundles: registry
results live in `registryHits`, never merged into source `hits`.

### 3. Every token must earn its place

Default output should stay lean. Search and curate are for choosing; show is
for using.

- **Search is a menu.** Default search output should expose only enough to
  choose the next asset. In the current CLI that usually means:
  - `brief`: `type`, `name`, `ref`, `action`, `estimatedTokens`, `keys` —
    `ref` is deliberately present at the leanest level so an agent can run
    `akm show <ref>` without asking for fuller detail
  - `normal`: adds `description` and `score`

  Richer provenance/debug fields belong behind fuller detail modes.

- **Show is a dispatch envelope.** Show should return the payload that lets
  the consumer act:
  - script execution hints
  - skill instructions
  - command templates
  - agent prompts
  - knowledge/wiki content
  - workflow steps and parameters
  - env key names without secret values
  - secret metadata without the secret value

### 4. Discovery chooses; show delivers

Search and curate should not accumulate show-level detail. `full` detail
modes can expose more metadata, but the base mental model stays:

```text
search/curate decide
show delivers
filesystem is optional depth
```

### 5. Refs are opaque durable handles

Consumers should treat refs as opaque lookup handles. The current wire
format is `[bundle//]conceptId[#fragment]`, but agents should pass refs
through rather than parse them. See `docs/architecture/specs/ref.md`.

### 6. Execution requires an explicit supported surface

akm retrieves every supported capability type. It directly orchestrates
defined execution surfaces such as workflows, agent dispatch, tasks, and
guarded subprocess injection. It does not blindly execute arbitrary indexed
content merely because that content appears in search results.

### 7. Improvement is evidence-driven and reviewable

Feedback and usage signal drive `akm improve`, which produces reviewable,
diffable proposals rather than silent rewrites. Accept, reject, and revert
stay human- or policy-gated, and proposals target only writable bundles.

### 8. Writes are destination-aware and fail closed

Writes target only writable bundles/adapters. Read-only adapters and
protected env/secret values are never silently written through — a write
aimed at a non-writable destination fails rather than falling back to an
unintended target.

### 9. Output serves agents first

The default consumer is structured-output automation. JSON-first and
concise detail levels are the right defaults.

### 10. Complexity belongs behind indexing and source management

The hard parts should stay inside indexing, source resolution, registry
install, and provider plumbing, not in the hot path from `search`/`curate`
to `show`/`use`.

### 11. Agent harnesses are thin, replaceable internals

akm is simple, lightweight tooling for agents and automated processes. A harness
such as OpenCode (pi or another later) is an internal detail akm uses to enable
agentic work. It sits behind one thin seam, is not woven into akm core, and can
be replaced without touching the rest of akm. Heavy machinery and tight
coupling are the opposite of akm's goals.

## What akm Does Not Do

- blindly execute arbitrary indexed content just because it appears in
  search results — akm orchestrates only defined execution surfaces
  (workflows, agent dispatch, tasks, guarded subprocess injection)
- expose secret/env values through `show`
- replace live-service integrations such as MCP — akm complements MCP and
  assistant-native skills rather than replacing them
- require agents to understand source layouts or provider internals
