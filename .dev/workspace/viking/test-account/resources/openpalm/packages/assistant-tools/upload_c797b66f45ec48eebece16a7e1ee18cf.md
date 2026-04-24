# @openpalm/assistant-tools

OpenCode plugin that registers all tools, hooks, and skills for the OpenPalm assistant. Published to npm and loaded by the assistant container at startup.

## What it provides

- **30+ tools** — admin operations (containers, channels, lifecycle, config, connections, artifacts, automations, audit) and memory operations (search, add, update, delete, list, stats, apps, feedback, exports, events)
- **Memory hooks** — `MemoryContextPlugin` injects scoped memories (personal/project/stack/global), feeds back outcomes, and exports memory env vars
- **Skills** — reference guides for admin API and memory usage (`opencode/skills/`)

## Structure

```
src/index.ts              # Plugin entry — registers all tools + memory hooks
opencode/tools/           # One file per tool group (admin-containers.ts, memory-search.ts, etc.)
opencode/plugins/         # memory-context.ts — automatic memory integration
opencode/skills/          # SKILL.md reference guides
AGENTS.md                 # Assistant persona and behavioral guidelines
```

## How it loads

The assistant's `opencode.jsonc` lists this package in its `"plugin"` array. OpenCode installs it from npm on startup (offline fallback at `/etc/opencode/node_modules/`). See [`core/assistant/README.md`](../../core/assistant/README.md) for the full plugin architecture.

## Building

```bash
bun build src/index.ts --outdir dist --format esm --target node
```

## Dependencies

`@opencode-ai/plugin` — OpenCode plugin interface. Tools call the admin API via standard `fetch`; no other runtime dependencies.

See [`AGENTS.md`](AGENTS.md) for the assistant persona, [`docs/core-principles.md`](../../docs/technical/core-principles.md) for architectural rules.
