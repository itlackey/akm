# Project Architecture Overview

## System Design

Agentikit (akm) is a CLI tool for managing AI agent assets — skills, commands,
agents, knowledge, and memories. It uses a local "stash" directory with SQLite
FTS5 indexing for fast search.

## Key Components

- **CLI**: Built with citty, handles user commands (`search`, `show`, `add`)
- **Stash**: Local directory tree organized by asset type
- **Indexer**: Walks the stash, extracts metadata, builds FTS5 + vector indexes
- **Providers**: Pluggable registry backends (skills.sh, openviking)
- **Renderers**: Format assets for display (`akm show`)

## Data Flow

1. User runs `akm search "query"`
2. CLI searches local stash (FTS5) and configured registries in parallel
3. Results are merged, deduplicated, and ranked
4. User selects a result → `akm show <ref>` displays full content
