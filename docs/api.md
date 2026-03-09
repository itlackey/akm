# Library API

Agentikit exports its core functions for use as a library in TypeScript and
JavaScript projects.

```ts
import {
  agentikitAdd,
  agentikitClone,
  agentikitInit,
  agentikitIndex,
  agentikitList,
  agentikitRemove,
  agentikitReinstall,
  agentikitSearch,
  agentikitShow,
  agentikitUpdate,
  resolveStashSources,
} from "agentikit"
```

## Functions

| Function | Description |
| --- | --- |
| `agentikitInit()` | Initialize stash directory and config |
| `agentikitIndex({ full?, stashDir? })` | Build or rebuild the search index |
| `agentikitSearch({ query, type?, limit?, usage?, source? })` | Search local stash and/or registry |
| `agentikitShow({ ref, view? })` | Show asset content by ref (async, auto-installs if needed) |
| `agentikitAdd({ ref })` | Install a kit from npm, GitHub, or local path |
| `agentikitList()` | List installed kits with status flags |
| `agentikitRemove({ target })` | Remove an installed kit and reindex |
| `agentikitUpdate({ target?, all? })` | Update one or all kits to latest version |
| `agentikitReinstall({ target?, all? })` | Reinstall one or all kits from stored refs |
| `agentikitClone({ sourceRef, newName?, force? })` | Copy an asset into the working stash |
| `resolveStashSources()` | Resolve all stash sources in priority order |
