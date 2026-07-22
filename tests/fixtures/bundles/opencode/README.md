# Fixture: `opencode` tool-dir bundle (SPECIFICATION goldens)

A minimal `.opencode` tool directory. The `opencode` adapter is a translator
that derives the open `type` from directory + frontmatter; `opencode.json` is
runtime config and is never indexed.

- **Adapter built by:** a future Chunk-2 format-adapter work item (no `opencode`
  adapter exists in `src/core/adapter/adapters/` yet).
- **Goldens:** `tests/fixtures/format-family-goldens/opencode/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §7 (opencode row), §6
  (type derivation), §8 (one adapter per tool dir).
- **Real-world source:** https://opencode.ai/docs/commands/ ,
  https://opencode.ai/docs/agents/ , https://opencode.ai/docs/skills/ ,
  https://opencode.ai/docs/rules/

Files: `AGENTS.md` (instruction), `commands/test.md` (command),
`command/legacy.md` (command via the SINGULAR-dir backwards-compat alias),
`agents/explorer.md` (agent), `skills/changelog/SKILL.md` (skill; item = the
dir), `opencode.json` (runtime config — NOT indexed).

**Directory plurality (open question 6 — RESOLVED, maintainer 2026-07):** BOTH
forms are accepted. Canonical OpenCode uses PLURAL `commands/`/`agents/`/
`skills/` (spec §7); singular `command/`/`agent/`/`skill/` are backwards-compat
aliases the adapter also accepts on read. The `command/legacy.md` fixture
exercises the singular alias directly. Writes normalize to the canonical plural
(placeNew emits `commands/`/`agents/`/`skills/`). **Cross-read:** OpenCode also
reads `.claude/skills/*/SKILL.md` via the shared SKILL.md codec (documented, not
duplicated as a fixture file).
