# Release-notes corpus for `akm help migrate`

This directory holds one `.md` file per release. Each file is the short,
focused migration note that `akm help migrate <version>` prints to the
terminal. The longform cross-release guide for the current release
(`v0.8-to-v0.9.md`) lives one level up in `docs/migration/`. Notes for
past releases are pruned from `main` once superseded — fetch them from
the matching release tag (e.g.
`https://github.com/itlackey/akm/blob/v0.8.0/docs/migration/release-notes/`).

## Adding notes for a new release

1. Create `<version>.md` in this directory (e.g. `0.7.0.md`).
2. Write plain text — the content is printed verbatim. Start the body
   with a line like `Migration notes for akm v0.7.0`, then list the
   automatic migrations, manual actions, publisher changes, etc.
3. The file ships with the published package via `package.json` →
   `files[]` and is resolved at runtime from either `src/` or `dist/`,
   so no code change is required.
4. Link to the longform guide in the last paragraph if one exists.

Keep each note self-contained: it should tell a user everything they
need to upgrade without requiring them to open a browser (the longform
guide link is the last resort, not the first).
