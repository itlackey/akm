# Fixture: `opencode` tool-dir bundle (SPECIFICATION goldens)

A minimal `.opencode` tool directory. The `opencode` adapter is a translator
that derives the open `type` from directory + frontmatter; `opencode.json` is
runtime config and is never indexed.

- **Adapter built by:** a future Chunk-2 format-adapter work item (no `opencode`
  adapter exists in `src/core/adapter/adapters/` yet).
- **Goldens:** `tests/fixtures/format-family-goldens/opencode/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/design/akm-0.9.0-bundle-adapter-spec.md` §7 (opencode row), §6
  (type derivation), §8 (one adapter per tool dir).
- **Real-world source:** https://opencode.ai/docs/commands/ ,
  https://opencode.ai/docs/agents/ , https://opencode.ai/docs/skills/ ,
  https://opencode.ai/docs/rules/

Files: `AGENTS.md` (instruction), `commands/test.md` (command),
`agents/explorer.md` (agent), `skills/changelog/SKILL.md` (skill; item = the
dir), `opencode.json` (runtime config — NOT indexed).

**Directory plurality:** canonical OpenCode uses PLURAL `commands/`/`agents/`/
`skills/` (spec §7); singular `command/`/`agent/` are backwards-compat aliases
the adapter should also accept. **Cross-read:** OpenCode also reads
`.claude/skills/*/SKILL.md` via the shared SKILL.md codec (documented, not
duplicated as a fixture file).
