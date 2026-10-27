# Fixture: `opencode` tool-dir bundle (SPECIFICATION goldens)

A minimal `.opencode` tool directory. The `opencode` adapter is a translator
that derives the open `type` from directory + frontmatter; `opencode.json` is
runtime config and is never indexed.

- **Adapter:** `src/core/adapter/adapters/opencode-adapter.ts`
- **Goldens:** `tests/fixtures/format-family-goldens/opencode/{recognition,lint,renderer}.json`
- **Real-world source:** https://opencode.ai/docs/commands/ ,
  https://opencode.ai/docs/agents/ , https://opencode.ai/docs/skills/ ,
  https://opencode.ai/docs/rules/

Files: `AGENTS.md` (instruction), `commands/test.md` (command),
`agents/explorer.md` (agent), `skills/changelog/SKILL.md` (skill; item = the
dir), `opencode.json` (runtime config — NOT indexed).

Only the canonical plural `commands/`/`agents/`/`skills/` directories are
accepted. **Cross-read:** OpenCode also
reads `.claude/skills/*/SKILL.md` via the shared SKILL.md codec (documented, not
duplicated as a fixture file).
