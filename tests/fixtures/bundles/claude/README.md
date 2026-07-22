# Fixture: `claude` tool-dir bundle (SPECIFICATION goldens)

A minimal `.claude` tool directory. The `claude` adapter (a translator) derives
the open `type` from directory + frontmatter and emits IndexDocuments; runtime
config (`settings.json`, `.mcp.json`) is never indexed.

- **Adapter built by:** a future Chunk-2 format-adapter work item (the `claude`
  adapter does not exist in `src/core/adapter/adapters/` yet — only `okf` + `akm`
  are built). These goldens are the spec-authored target it must hit test-first.
- **Goldens:** `tests/fixtures/format-family-goldens/claude/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §6 (type derivation), §7
  (claude adapter row), §8 (one adapter per tool dir).
- **Real-world source:** https://code.claude.com/docs/en/claude-directory ,
  https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

Files: `CLAUDE.md` (instruction), `commands/deploy.md` (command),
`agents/reviewer.md` (agent), `skills/pdf-processing/SKILL.md` (+ bundled
`reference.md` resource) (skill; item = the dir), `settings.json` + `.mcp.json`
(runtime config — NOT indexed).
