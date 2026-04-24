# Project Context Memory

The agentikit project is focused on building a flexible, extensible toolkit for
managing AI agent assets. The core philosophy is YAGNI + KISS — only build what's
needed, keep it simple.

## Current Focus

- OpenViking integration as a registry provider
- Flexible asset type system (extensible without code changes)
- Memory as a first-class asset type

## Key Decisions

- Runtime: Bun (fast, good SQLite support)
- CLI framework: citty (lightweight, composable)
- No public API — CLI-only package
