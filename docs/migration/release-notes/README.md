# Release-notes corpus for `akm help migrate`

This directory holds one `.md` file per release. Each file is the short,
focused migration note that `akm help migrate <version>` prints to the
terminal. The longform cross-release guides (e.g. `v0.5-to-v0.6.md`)
live one level up in `docs/migration/`.

## Available notes

- [0.9.19](0.9.19.md) — Bundle-scoped improve planning, proposal reopen, and consolidate/distill guardrails.
- [0.9.17](0.9.17.md) — Retire proposals, declared links replacing the LLM entity graph, and scoped improve planning.
- [0.9.16](0.9.16.md) — Source-bound scheduler grants, local execution authority, and split unsafe overrides.
- [0.9.15](0.9.15.md) — Lease/state.db contention exit code 75, scheduled-task engine requirements, and safer launchers.
- [0.9.14](0.9.14.md) — Index v22→v23 derived-cache rebuild, lexical fragments, and collapse-detector canaries.
- [0.9.2](0.9.2.md) — Task source v4 migration, workflow source IR v1, and durable-v4-family `irVersion: 5`.
- [0.9.0](0.9.0.md) — 0.9 release-candidate and final-release migration notes.
- [0.8.0](0.8.0.md) — CLI/storage break, improve-owned graph pipeline, config v2, and task assets.
- [0.7.5](0.7.5.md) — Patch rollup for everything shipped on `main` after v0.7.4.
- [0.7.4](0.7.4.md) — Publish-process-only patch release with no functional change from 0.7.3.
- [0.7.3](0.7.3.md) — Stability improvements, security hardening, and UX refinements.
- [0.7.0](0.7.0.md) — Last v1-cycle pre-1.0 release with the proposal queue and improve-loop groundwork.
- [0.6.0](0.6.0.md) — v1 architecture refactor, stash rename cleanup, and sandbox/setup guidance.
- [0.5.0](0.5.0.md) — Wiki, workflow, vault, and save command additions before the 0.6 architecture cut.
- [0.3.0](0.3.0.md) — Fold the old `stash` and `kit` command groups into the top-level CLI.
- [0.2.0](0.2.0.md) — User-facing `type:name` refs and early bundle conventions.
- [0.1.0](0.1.0.md) — Rebrand from Agent-i-Kit to akm.
- [0.0.13](0.0.13.md) — Initial public release.

## Adding notes for a new release

1. Create `<version>.md` in this directory (e.g. `0.7.0.md`).
2. Start the file with `# akm v<version> migration notes`, then list the
   automatic migrations, manual actions, publisher changes, and any longform
   guide links the terminal user may need.
3. The file ships with the published package via `package.json` → `files[]`
   and is resolved at runtime from either `src/` or `dist/`, so no code
   change is required.
4. Link to the longform guide in the last paragraph if one exists.

Keep each note self-contained: it should tell a user everything they need to
upgrade without requiring them to open a browser (the longform guide link is
the last resort, not the first).
