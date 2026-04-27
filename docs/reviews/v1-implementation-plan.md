# akm v1 — Implementation Plan (Superseded)

**Status:** Superseded on 2026-04-27.

This document previously described the stash→source refactor plan used during the `v0.6` cycle.

## Why this is superseded
The current v1 direction is now defined by the **Agent Reflection and Self-Evolution** proposal (2026-04-26), which changes v1 scope to include:
- agent CLI integration (shell-out only),
- proposal queue and `quality: "proposed"`,
- `akm reflect` / `akm propose` / `akm proposal *` workflows,
- lesson distillation and bounded in-tree LLM feature flags,
- contract hardening around open enums and validation rules.

## Replacement documents
- Issue backlog for implementation: `docs/reviews/v1-agent-reflection-issues.md`
- Contract source of truth (to be updated as work lands): `docs/technical/v1-architecture-spec.md`

## Historical note
The prior plan is retained in git history only. Do not use it for new implementation work.
