# Working on AKM Desktop

Desktop is a convenience tool for the human owner of an akm instance; the CLI serves agents.
`akm ui` and akm's HTML output are frozen and will be removed once Desktop builds for Linux, macOS and Windows.

## Where code goes

- Business logic lives in AKM. Application code imports only `akm-cli/workspace` (and `akm-cli/package.json`);
  never deep-import `dist/` or `../../src/*`, and never read or write AKM's own data paths directly.
  `tests/integration-contract.test.mjs` checks the imports.
- **AKM** owns a feature when an agent or script would plausibly want it, when it owns AKM data (stash content,
  indexes, config, proposals, archives), or when it needs AKM's invariants (ref resolution, write targets, revision,
  lease, git, redaction). Retire, copy, proposals, env/secret writes, related content and bundle operations are AKM
  operations; if one is missing, add it to AKM rather than composing write primitives here.
- **Desktop** owns the rest, and only here:
  - server features in `src/lib/server/features/` (plain file editing is the first);
  - main-process privilege in `electron/`;
  - presentation and view models in `src/lib/`.
  A feature may call several AKM operations and must report a partial outcome as data. It never repairs AKM state itself.
- Desktop-owned routes are under `/api/desktop/*`; every other `/api` path is AKM's. Errors become HTTP statuses in one
  place, `src/lib/server/http.ts`. An unknown request field is ignored with one warning, never rejected.

## Editing files

The owner may read and write any text file inside a configured bundle with plain file operations.
Keep only real safety: stay inside the bundle root by real path, refuse a save over bytes that changed since they were
read, and write atomically. Then ask AKM to refresh the index for that path (`indexWrittenAssets`).

## Rules

- Use the existing public API semantics. New deletions, schema changes or proposal behavior require a separate scoped design.
- Keep the renderer sandboxed and the server private to the app. Test authentication, source conflicts and credential
  redaction after changes.
- Test only against generated synthetic HOME/XDG/AKM paths. Do not run manual writes, provider requests or bundle
  operations against a developer's real data.
- Preserve user files and unrelated work. Do not clean live bundles or config.
- Before handoff: `npm run check`, `npm run build`, `npm test`, `npm run test:e2e`, and native/package checks where
  supported (`docs/verification.md`). Review actual screenshots; passing DOM tests alone are not a visual review.
- Desktop's version is the akm version it embeds. Do not publish releases, mirror to GitHub, or add deployment secrets
  without authorization.
