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
| `electron/` | Window, local server lifecycle, external browser links, application-menu install |
| `src/hooks.server.ts` | Per-launch authentication and same-origin checks |
| `src/lib/server/` and `src/routes/api/` | HTTP shell (`http.ts`: the one error-to-status mapping, unknown request fields warned and ignored), existing AKM API dispatch, native host software command orchestration |
| `src/lib/server/features/` | Desktop-only features built on `akm-cli/workspace` (plain file editing) |
| `src/lib/*.svelte` | Presentation, review confirmation, retained editor drafts |
| `src/lib/navigation.ts` | SvelteKit navigation with draft-aware Back/forward and retained section state |
| `src/lib/upstream/` | Reused AKM design tokens, escaped Markdown, diff and chart presentation |
| `akm-cli/workspace` | Existing reads/writes, validation, policy, proposals, persistence |

The namespace is a small set of existing operations (dispatchers, managed clone,
redaction, errors and the env/secret operations) with a Node loader entry and
hand-written types. The v1 folder workspace also adds read-only APIs to AKM itself:
`GET /api/bundle/files` lists one actual directory in an enabled, registered
bundle, resolves canonical indexed refs, and reports unindexed files honestly
(it reuses AKM's source roots, containment rules and read-only index connection;
it does not recursively scan, read file bodies, create an index or mutate files),
and `GET /api/asset/related` lists the nearest stored embeddings of an asset.
Asset reads carry their physical bundle location for breadcrumbs. These small
extensions live in AKM core in this repository, not a second Desktop engine. Every
route Desktop does not own falls through to AKM's own dispatcher. The copy route
is a thin validated call to existing `akmClone`, with overwrite disabled. No raw
arbitrary filesystem mutation is exposed by the app.

Related content is AKM's `GET /api/asset/related`, which reads only stored vectors
(never a provider or a second vector store) through search's own entry filter.
Desktop is a convenience tool for the human owner of the instance, so it edits
files with plain file operations (`features/files.ts`, `GET /api/desktop/file`
and `POST /api/desktop/file/save`): any UTF-8 text file inside an enabled bundle,
including a skill's support files and files that are no asset. The only
restrictions are real safety. The real path must stay inside the bundle root (a
link cannot leave it), a save is refused when the file's bytes changed since they
were read (the revision is their SHA-256), and the write is atomic (temporary
file, then rename, keeping the mode). Afterwards Desktop asks AKM to refresh the
index for that file with `indexWrittenAssets`, the one index operation the
workspace exports. `env/` and `secrets/` have their own masked view. Knowledge and
memory documents are saved through AKM's Markdown writer, which records its event
and commits; a plain file save does not touch Git. Asset-level operations (retire,
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

- The compact top bar holds Library, Review, Activity and Settings. Sections
  mount on first visit; subsequent navigation preserves editors. Deep links,
  Back/forward and query filters use SvelteKit navigation; leaving a dirty editor
  is guarded before route changes. Folder expansion and focus are local state.
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

The app is a source-integrated test build, not a public release or a claim that the larger
asset-manager design is complete. Desktop has no version of its own: it is the
version of the AKM it embeds, and `scripts/package.mjs --appimage` refuses a dirty
tree or a commit not tagged `v<version>`. See `verification.md` for actual checks
and remaining limits.
The AppImage remains an unsigned Linux test artifact. Release
signing, installers, macOS/Windows verification, and public distribution are
separate distribution work. Setup builds and packs core from this checkout into
the ignored `.core/` directory. The dependency is a local package, not a private
tarball, source patch or registry release.

## Software lifecycle

Desktop does not update itself: replace the AppImage with a newer download.
Electron main only installs the per-user application-menu entry; the server asks
it over an allowlisted `status` / `menu-install` message, and no renderer Node or
preload API is added. Normal close respects unsaved-work confirmation and waits
for host mutations.

Host CLI installation uses AKM's official checksum-verifying user-local
installer. Upgrades call the detected host `akm upgrade`; they never execute the
bundled workspace dependency's updater. Harness installation calls the native
Claude/Codex marketplace and OpenCode plugin commands. No shell-interpolated
commands, copied config writers, hook approval or forced channel switching are
introduced. Diagnostics expose lifecycle summaries, not raw native output.
See [Software](software.md) for use.
