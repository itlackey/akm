# Fixture: `agent-skills` bundle (SPECIFICATION goldens)

A collection of standalone `SKILL.md` packages (like github.com/anthropics/skills).
The `agent-skills` adapter emits `type=skill` (item = the package dir) and
enforces the Agent Skills contract (§4.5) STRICTLY.

- **Adapter built by:** a future Chunk-2 format-adapter work item. The SKILL.md
  codec is shared with `claude`/`opencode` as functions (spec §8).
- **Goldens:** `tests/fixtures/format-family-goldens/agent-skills/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §7 (agent-skills row),
  §6 (skill row), §4.5 (Agent Skills contract).
- **Real-world source:** https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
  , the vendored `skills-ref` validator (0.1.0), https://github.com/anthropics/skills

Files:
- `pdf-processing/SKILL.md` (+ `reference/FORMS.md` resource) — **conformant**.
- `Data_Analysis/SKILL.md` — **hard-rule violation**: name fails the charset rule
  `^[a-z0-9]+(-[a-z0-9]+)*$` (uppercase + underscore).
- `overlong-summary/SKILL.md` — **hard-rule violation**: description is 1237 chars
  (> the 1024 limit).

The two violations exercise the lint golden's §4.5 checks (recognition still
recognizes them — recognition ≠ validation).
