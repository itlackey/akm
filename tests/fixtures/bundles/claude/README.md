# Fixture: `claude` tool-dir bundle (SPECIFICATION goldens)

A minimal `.claude` tool directory. The `claude` adapter (a translator) derives
the open `type` from directory + frontmatter and emits IndexDocuments; runtime
config (`settings.json`, `.mcp.json`) is never indexed.

- **Adapter:** `src/core/adapter/adapters/claude-adapter.ts`
- **Goldens:** `tests/fixtures/format-family-goldens/claude/{recognition,lint,renderer}.json`
- **Real-world source:** https://code.claude.com/docs/en/claude-directory ,
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

Files: `CLAUDE.md` (instruction), `commands/deploy.md` (command),
`agents/reviewer.md` (agent), `skills/pdf-processing/SKILL.md` (+ bundled
`reference.md` resource) (skill; item = the dir), `settings.json` + `.mcp.json`
(runtime config — NOT indexed).
