# Architecture and scope

```text
Electron main
  ├─ sandboxed BrowserWindow → SvelteKit UI
  └─ private Node child → loopback SvelteKit server
                          └─ akm-cli/workspace
                               └─ existing AKM domain functions / CLI children
```

The installed package contains AKM and Electron. Workspace operations use the
bundled engine through Electron's Node runtime. They never substitute a global
`akm` or require a sibling checkout. The separate Software view discovers the
host CLI/harnesses strictly for explicit installation and upgrade management.

## Responsibilities

| Layer | Owns |
| --- | --- |
| `electron/` | The privileged shell only: window, local server lifecycle, external browser links, application-menu install |
| `server/` | The web process (`server.mjs`): per-launch token, loopback HTTP listener, the built app. Runs on plain Node or Bun; imports nothing from Electron |
| `src/hooks.server.ts` | Per-launch authentication and same-origin checks |
| `src/lib/server/` and `src/routes/api/` | HTTP shell (`http.ts`: body limits, envelope, scrubbing and the one error-to-status mapping) over one route table (`routes.ts`: each route names a workspace operation and its input; unknown request fields are warned and ignored) |
| `src/lib/server/features/` | Desktop-only features built on `akm-cli/workspace`: plain file editing, secret reveal policy, preferences, native host software orchestration |
| `src/routes/` and `src/params.ts` | Page routes (`ssr = false`): `/`, `/setup`, `/library/[view]`, `/review/[[id]]`, `/activity/[view]`, `/settings/[section]`; `+layout.svelte` is the shell (top bar, appearance, the leave-draft guard in `beforeNavigate`) |
| `src/lib/state/workspace.svelte.ts` | Workspace-wide state (bundles, pending count, theme, where each section was last left) and its refreshers; per-view state stays in the page |
| `src/lib/drafts.ts` | Stored editor drafts (session storage), the unsaved flag, and re-keying drafts when a bundle is renamed |
| `src/lib/*.svelte` | Presentation and review confirmation |
| `src/lib/navigation.ts` | `goto` for in-app navigation, so Back/forward goes through `beforeNavigate` |
| `src/lib/ui/` | Desktop-owned presentation: design tokens, escaped Markdown, diff and chart rendering |
| `akm-cli/workspace` | Typed operations: reads, writes, validation, policy (revisions, leases, writability), proposals, persistence |

The namespace is a set of typed operations grouped by capability (assets, documents, proposals, bundles, config,
feedback, sensitive, setup, activity) with a Node loader entry and hand-written types; it exports no primitive and no
dispatcher. The v1 folder workspace also uses read-only operations in AKM itself:
`assets.bundleFiles` (`GET /api/bundles/files`) lists one actual directory in an enabled, registered
bundle, resolves canonical indexed refs, and reports unindexed files honestly
(it reuses AKM's source roots, containment rules and read-only index connection;
it does not recursively scan, read file bodies, create an index or mutate files),
and `assets.related` lists the nearest stored embeddings of an asset.
Asset reads carry their physical bundle location for breadcrumbs. These operations
live in AKM core in this repository, not a second Desktop engine. Copy is
`documents.copy`, with overwrite disabled. No raw
arbitrary filesystem mutation is exposed by the app beyond plain file editing inside a bundle.

Related content is AKM's `assets.related`, which reads only stored vectors
(never a provider or a second vector store) through search's own entry filter.
Desktop is a convenience tool for the human owner of the instance, so it edits
files with plain file operations (`features/files.ts`, `GET /api/desktop/file`
and `POST /api/desktop/file/save`): any UTF-8 text file inside an enabled bundle,
including a skill's support files and files that are no asset. The only
restrictions are real safety. The real path must stay inside the bundle root (a
link cannot leave it), the bundle must be one AKM writes to (an installed
bundle's update would replace the edit), a save is refused when the file's bytes changed since they
were read (the revision is their SHA-256), and the write is atomic (temporary
file, then rename, keeping the mode). Afterwards Desktop asks AKM to refresh the
index for that file with `indexWrittenAssets`, the one index operation the
workspace exports. `env/` and `secrets/` (checked on the real path) have their own
masked view. A save does not touch Git; `akm sync` commits it like any other
edit. Asset-level operations (retire,
copy, proposals, env/secret, related content, bundle operations) stay AKM's.

A move is two AKM operations: copy (`akmClone`, which never overwrites and
records the original in the copy's `sources`), then retire of the original.
Links to the old name are not rewritten; `akm lint` reports them. A skill can be
copied but not retired, so it cannot be moved. Because the retirement is a
proposal, Undo restores the original and leaves the copy.

Manual retirement is core's ordinary retire proposal, minted and accepted at
once and guarded by the displayed source revision. It follows the same
lifecycle as an agent-proposed retirement: the row appears in Review and
Activity, the archive is grace-purged on the same schedule, and Undo is the
existing proposal revert, which moves the archive back without overwriting
newer files and removes it. Desktop adds no archive or restore logic.
Agent-proposed retirements still use the unchanged review workflow.

Protected-file CRUD reuses native env writing/removal, secret writes and
removal (`akm secret remove`), atomic 0600 writes and Git policy, resolved
through the same write-target operations as the CLI (so a dotenv-adapter bundle
is writable). Like the CLI, it does not touch the index and takes no lease of
its own around the revision check (the write itself holds the lease). It accepts
only env/secret paths inside a writable registered source. Save/delete check the
displayed revision; create refuses an existing destination. Values never appear
in operation receipts, argv, retained drafts or recovery copies. Delete uses the
exact confirmed path and clears its sensitive marker. A file listed in Files
without a ref is named with core's `deriveCanonicalAssetName`.

Bundle rename is core's `bundle-rename` workspace action, which runs
`akm bundle rename` (with `--dry-run` for the preview). Desktop adds no identity
migration, scheduler or database logic. It presents native preview/results, refreshes its Library
location and remaps retained document drafts. The physical directory is not
renamed; authored content references are reported, not rewritten.

## Desktop-only features

A feature belongs in AKM when an agent or script would plausibly want it, or when
it owns AKM data or needs AKM's invariants. Everything else is Desktop's, and
lives in `src/lib/server/features/` (server), `electron/` (main-process
privilege) or a renderer view model. Desktop code imports only `akm-cli/workspace`
and `akm-cli/package.json`, never `akm-cli/dist/*` or `../../src/*`, and never
reads or writes AKM's own data paths. A feature may call several AKM operations
and must report a partial outcome as data. `tests/integration-contract.test.mjs`
checks the import rule for server code. Desktop-owned routes are under
`/api/desktop/*`; every other `/api` path is AKM's.

## Local application boundary

The server binds an OS-selected port on `127.0.0.1`. A random per-launch token
bootstraps an HttpOnly, SameSite=Strict cookie and is removed from the browser
URL. The app refuses foreign Host/Origin requests, validates JSON body sizes,
and does not enable CORS. Its token is redacted by AKM's configuration inspector.
This local HTTP listener is implementation detail, **not** a public API server.

The renderer has no Node integration or preload authority. Electron sandboxing
and context isolation remain enabled. Native permission requests, embedded
webviews and downloads are denied. External HTTP(S) links open the user's
browser; custom-scheme links are not handed to the OS. Markdown is sanitized,
with executable content and remote images excluded.

Same-user malware is outside this boundary. The app intentionally has the
operator's existing AKM access; source policy remains enforced by AKM. Closing
the app stops the child server. Navigation never resizes its window.

## UI behavior

- The compact top bar holds Home, Library, Review, Activity and Settings. Each is a page
  route, so a view is addressable and reloads where it was; the bar returns to where a
  section was last left. Query filters, Back/forward and deep links are ordinary
  SvelteKit navigation; leaving a dirty editor is guarded in `beforeNavigate`, and a draft
  is kept for when the editor is opened again. Folder expansion and focus are local state.
  Page requests are served as the app shell, and the server's protocol comes from a
  server-owned header because adapter-node 6 takes an origin only from a build-time setting.
- Ordinary document drafts are retained per asset in session storage. Leaving an edited asset asks
  whether to stay or leave and retain the draft. Closing a window with drafts prompts; drafts
  are not durable backups. Inputs are disabled during a save.
- Settings saves preserve edits in other groups and refresh the Library's
  current results and non-editing asset inspector.
- Source saves use the existing revision token. A stale revision cannot silently
  overwrite concurrent changes; the user must review and merge the latest text.
- Proposal decisions use the existing validation and recovery rules. A failed
  batch is not reported as all-success; individual results remain visible.
- Search/asset responses carry generation guards so late requests cannot replace
  newer selections. Environment and secret reads initially return only metadata.
  Desktop's explicit authenticated Show action returns literal text with no-store
  caching, rendered as escaped text rather than Markdown. Hide and navigation
  clear it; late responses cannot reveal a file after leaving it. This local
  viewer does not change core CLI redaction. Explicit Edit opens a plain-text
  editor with no persistent draft storage. Leaving dirty protected-file edits
  asks to keep editing or discard; saves remask values. Window close also guards
  these in-memory edits.
- No new metric definitions or synthetic success scores are invented for charts.
- The appearance setting is Desktop-only presentation state; its small JSON
  file is separate from AKM config. A private validated endpoint reads/writes
  only that preference. Ephemeral server ports do not lose the saved choice.

## Distribution status

Desktop has no version of its own: it is the version of the AKM it embeds, and it ships in
the same release as that AKM (one version, one tag, one changelog). Setup builds and packs
core from this checkout into the ignored `.core/` directory for development and CI.
A distributable build (`scripts/package.mjs --release`) refuses a dirty tree and any engine
that is not the released `akm-cli` tarball (`scripts/core.mjs --tarball`). The release workflow's
`desktop` job runs it on Linux, macOS and Windows, after the npm publish, from the very tarball
that was published, and attaches the installers to the same GitHub release: a Linux AppImage,
a macOS dmg and zip (arm64), and a Windows NSIS installer (x64). They are unsigned;
see [Software](software.md#unsigned-installers). CI packages and starts Desktop on all three
platforms (`scripts/smoke.mjs`), so a change that breaks one is seen before a release.

## Software lifecycle

Electron main installs the per-user application-menu entry and runs the updater
(`electron/updater.mjs`, electron-updater's `github` provider, no token, no other feed). The
server asks it over an allowlisted `status` / `menu-install` / `pick-folder` message (the last opens the
operating system's folder dialog for adding a bundle, `electron/pick-folder.mjs`), and no renderer Node or
preload API is added. A stable build follows stable releases; a build of a stage release follows
prereleases, so the channel is the akm release stage. The Software view compares the built-in
engine with the host `akm` (`src/lib/engine-skew.ts`) and says which one to update. Normal close respects unsaved-work confirmation and waits
for host mutations.

Host CLI installation uses AKM's official checksum-verifying user-local
installer. Upgrades call the detected host `akm upgrade`; they never execute the
bundled workspace dependency's updater. Harness installation calls the native
Claude/Codex marketplace and OpenCode plugin commands. No shell-interpolated
commands, copied config writers, hook approval or forced channel switching are
introduced. Diagnostics expose lifecycle summaries, not raw native output.
See [Software](software.md) for use.
