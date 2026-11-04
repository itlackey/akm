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
| `electron/` | Window, local server lifecycle, external browser links, private desktop updater |
| `src/hooks.server.ts` | Per-launch authentication and same-origin checks |
| `src/lib/server/` and `src/routes/api/` | HTTP validation, existing AKM API dispatch, native host software command orchestration |
| `src/lib/*.svelte` | Presentation, review confirmation, retained editor drafts |
| `src/lib/navigation.ts` | SvelteKit navigation with draft-aware Back/forward and retained section state |
| `src/lib/upstream/` | Reused AKM design tokens, escaped Markdown, diff and chart presentation |
| `akm-cli/workspace` | Existing reads/writes, validation, policy, proposals, persistence |

The namespace adds exports, a Node loader entry, public types, and tests/docs.
The v1 folder workspace also adds one read-only API to AKM itself:
`GET /api/bundle/files`. It lists one actual directory in an enabled, registered
bundle, resolves canonical indexed refs, and reports unindexed files honestly.
It reuses AKM's source roots, containment rules and read-only index connection;
it does not recursively scan, read file bodies, create an index or mutate files.
Asset reads carry their physical bundle location for breadcrumbs. This small
extension lives in AKM core in this repository, not a second Desktop engine.
The copy route is a thin validated call
to existing `akmClone`, with overwrite disabled. No raw arbitrary filesystem
mutation is exposed by the app.

Related-content lookup calls the exported stored-vector repository, never a
provider or a second vector store. File organization composes native source
resolution, placement, write policy, mutation lease, indexing and lint with
ordinary filesystem operations on registered assets. Skill moves copy the
whole directory, verify source/destination bytes before removal, and retain
originals. Text editing uses the existing document writer for knowledge/memory
and the same core mutation boundaries for other file types.

Manual retirement is core's ordinary retire proposal, minted and accepted at
once and guarded by the displayed source revision. It follows the same
lifecycle as an agent-proposed retirement: the row appears in Review and
Activity, the archive is grace-purged on the same schedule, and Undo is the
existing proposal revert, which moves the archive back without overwriting
newer files and removes it. Desktop adds no archive or restore logic.
Agent-proposed retirements still use the unchanged review workflow.

Protected-file CRUD reuses native env writing/removal, secret writes, atomic
0600 writes and Git policy, resolved through the same write-target operations as
the CLI (so a dotenv-adapter bundle is writable). Like the CLI, it does not
touch the index. It accepts only env/secret paths inside a writable registered
source. Save/delete check the displayed revision;
create refuses an existing destination. Values never appear in operation
receipts, argv, retained drafts or new recovery copies. Delete uses the exact
confirmed path and clears its sensitive marker. Core behavior is unchanged.

Bundle rename is core's `bundle-rename` workspace action, which runs
`akm bundle rename` (with `--dry-run` for the preview). Desktop adds no identity
migration, scheduler or database logic. It presents native preview/results, refreshes its Library
location and remaps retained document drafts. The physical directory is not
renamed; authored content references are reported, not rewritten.

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
asset-manager design is complete. Private versions now use patch-only 0.0.x;
see `verification.md` for actual checks and remaining limits.
The AppImage remains an unsigned Linux test artifact. Release
signing, installers, macOS/Windows verification, and public distribution are
separate distribution work. Setup builds and packs core from this checkout into
the ignored `.core/` directory. The dependency is a local package, not a private
tarball, source patch or registry release.

## Software lifecycle

Electron main owns the encrypted Gitea token and electron-updater instance.
The existing authenticated server exchanges only allowlisted update status,
check and settings messages with main; no renderer Node or preload API is added.
Gitea resolves the release tag. Electron-updater owns version comparison,
artifact checksums, downloads and AppImage replacement. Downloads never quit
the application. Normal close respects unsaved-work confirmation, waits for
host mutations, stops the server, then installs a staged desktop update.

Host CLI installation uses AKM's official checksum-verifying user-local
installer. Upgrades call the detected host `akm upgrade`; they never execute the
bundled workspace dependency's updater. Harness installation calls the native
Claude/Codex marketplace and OpenCode plugin commands. No shell-interpolated
commands, copied config writers, hook approval or forced channel switching are
introduced. Diagnostics expose lifecycle summaries, not raw native output.
See [Software updates](software.md) for use and distribution.
