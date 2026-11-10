# Working on AKM Desktop

Desktop is a convenience tool for the human owner of an akm instance; the CLI serves agents.
Desktop replaces `akm ui` and akm's HTML output, which are removed; the CLI keeps `--format json|jsonl|yaml|text|md`.

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
  - main-process privilege in `electron/` (the only place that imports `electron` or `electron-updater`; `server/` is the
    runtime-neutral web process and must run on plain Node);
  - presentation and view models in `src/lib/`: pages are Kit routes in `src/routes/` (`ssr = false`), shared state is
    `lib/state/workspace.svelte.ts`, stored drafts are `lib/drafts.ts`, and the design-system code copied from AKM is
    Desktop's own in `lib/ui/`. Svelte components use runes; convert a legacy component when you change it.
  A feature may call several AKM operations and must report a partial outcome as data. It never repairs AKM state itself.
  Preferences, native host software (`host-tools.ts`, `software.ts`) and the secret reveal policy live there too.
  The harness plugin-install recipe in `host-tools.ts` stays in Desktop; `plugin-channels.ts` in akm is its source of truth.
- Desktop-owned routes are under `/api/desktop/*`; every other `/api` path is AKM's. Errors become HTTP statuses in one
  place, `src/lib/server/http.ts`; every route is one line of `src/lib/server/routes.ts`, naming its workspace operation. An unknown request field is ignored with one warning, never rejected.

## Dependencies

`electron-updater` is imported only by `electron/main.mjs` and `electron/release-feed.mjs`, and the web process (`server/`, `src/`) never needs it.
It stays in `dependencies` anyway: the packager stages a production-only install, so a devDependency would be missing
from the packaged app. `akm-web` (`scripts/package-web.mjs`) is that web-process-only distribution and leaves it out of its manifest.

## Editing files

The owner may read and write any text file inside a configured bundle with plain file operations.
Keep only real safety: stay inside the bundle root by real path, refuse a save over bytes that changed since they were
read, and write atomically. Then ask AKM to refresh the index for that path (`indexWrittenAssets`).

## Rules

- Use the existing public API semantics. New deletions, schema changes or proposal behavior require a separate scoped design.
- Keep the renderer sandboxed. The server listens on loopback unless `akm-web` is given `--host`, and then its token, Host and Origin checks are compared with the configured `--origin`; none can be turned off. Test authentication, source conflicts and credential
  redaction after changes.
- Test only against generated synthetic HOME/XDG/AKM paths. Do not run manual writes, provider requests or bundle
  operations against a developer's real data.
- Preserve user files and unrelated work. Do not clean live bundles or config.
- Format with `bun run format` at the repo root (biome: ts/mjs/js/css/json) and `npm run format` here (prettier:
  `.svelte`): one formatter per file type. Source files carry the MPL header; privileged JavaScript (`electron/`, `server/`, `scripts/`) is type-checked.
- Before handoff: `npm run check`, `npm run build`, `npm test`, `npm run test:e2e`, `npm run test:usability`, and
  native/package checks where supported (`docs/verification.md`). Review actual screenshots; passing DOM tests alone are not a visual review.
- Desktop's version is the akm version it embeds. Do not publish releases, mirror to GitHub, or add deployment secrets
  without authorization.
