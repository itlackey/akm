# AKM Desktop

A local workspace for reviewing and maintaining what your agents know.
SvelteKit supplies the UI and server-side routes; Electron supplies the desktop
window and Node runtime. Existing `akm-cli/workspace` functions own every AKM
operation. This app does not implement another asset store or proposal engine.

Linux development build. The task-first v1 includes:
website-like search and reading, a bundle-folder workspace for curation, a focused
proposal review desk, and separate technical views for health and metrics.
The Attention desk Home page provides a compact starting point for those workflows.
The compact top bar and established AKM palette remain. This is
not a pixel-for-pixel copy of `akm ui` or a claim that the larger asset-manager
design is complete.
Private builds use patch-only **0.0.x** versions; the commit ID is shown separately.
No public release, background service, or remote-management endpoint is included.
See [verification](docs/verification.md) for evidence and limits.

## Use it

The packaged app includes its own AKM dependency and runtime. On Linux, launch
the executable `.AppImage`; alternatively launch `akm-desktop` from an unpacked
application directory. No separate Node, Bun, or global AKM installation is
required at runtime.

It uses your normal local AKM configuration and bundles. Existing `AKM_*`
configuration overrides work as they do in the CLI. The hostname and bundled
AKM version appear in the header. Nothing is copied from another machine.

- **Home:** the default starting page, with failing checks and recorded run failures
  first, links to their details, common actions, weekly task outcomes, and the
  pending proposal count. The snapshot refreshes when you return. **Check health**
  refreshes local diagnostics; explicit network probes remain in Activity → Health.
  Missing measurements are marked unavailable, not healthy or zero. The run bar
  uses exact seven-day task totals; it does not invent a daily series or treat
  unfinished/unknown outcomes as failures. Existing deep links keep their destination.
- **Library:** search and read like a website, or switch to Files to browse real
  bundle folders with a keyboard-operable tree and breadcrumbs. Edit supported
  Markdown with formatting buttons and preview, or other text as source.
  Follow recorded connections, compare stored cosine similarity, rename/move
  single-file assets, move whole skills between bundles and edit their text
  files. Create, compare, copy, inspect history and record feedback. Diffs start inline.
  Environment files and secrets open masked; use **Show / Hide** to read them.
  Create, edit and delete them directly; values and edits stay in memory only,
  never in retained drafts. Leaving unsaved edits asks before discarding them.
- **Review:** inspect proposed changes and evidence; accept, reject, reopen,
  or revert when AKM supports it. Batch decisions retain individual outcomes.
- **Activity:** separate Health, Runs, Usage & retrieval, Improve impact and
  Source history views. Charts retain their data tables, periods and drilldowns;
  observations are not quality or causality scores.
- **Settings:** full bundle management and grouped, validated settings with
  scoped saves. Changing one settings group does not discard another's edits.
  Rename a bundle through **Manage → Rename bundle** without moving its folder.
  **Software** manages desktop updates, the host CLI and harness plugins.

Writes use AKM's normal policy: a Git-backed bundle may commit and push changes.
Read the confirmation and operation receipt. Copy preserves the original and
refuses an existing destination. Removing a registration is an explicit AKM
operation, not a generic file deletion tool.

Document edits detect concurrent source changes and keep your draft for manual review.
Unsaved drafts survive section changes and reloads in the same window, but are
not durable backups: save before closing the application.
Leaving an edited document asks whether to stay or leave and keep the draft;
moving focus or expanding the folder tree does not interrupt editing.

Library shows whether a draft is unsaved or restored, and offers an explicit
discard action that never changes the saved asset. Review's single-key shortcuts
are off by default; enable them under Keyboard shortcuts for the current window.
They work only while focus is inside Review, not while typing.

Appearance (System / Light / Dark) is saved separately from AKM settings in
`$XDG_CONFIG_HOME/akm-desktop/preferences.json` (normally
`~/.config/akm-desktop/preferences.json`). Other workspace state is session-local.

## Build from source

Use Bun 1.3.14 (the CI-pinned toolchain), Node 22.17+ (Node 24 LTS tested),
and tar. Desktop is an optional, isolated package in this repository; installing
the CLI does not install Electron or Svelte. No published workspace package or
private repository access is required.

```sh
git clone https://github.com/itlackey/akm.git
cd akm
bun install --frozen-lockfile
bun run desktop:setup
cd desktop
node node_modules/electron/install.js
npm run check
npm run build
npm start
```

`npm start` opens your real local AKM workspace. For synthetic verification use
the test commands below instead. A first-time user can register an existing
bundle from Settings; this version does not add a second provider setup wizard.

Setup disables dependency lifecycle scripts. The explicit Electron command above
downloads the pinned development runtime; nothing is downloaded at app startup.
Rerun `bun run desktop:setup` from the repository root after changing core.
It rebuilds and packs this checkout, then installs that package using Desktop's
own frozen Bun lockfile. Change dependencies with Bun in the relevant package;
use the CI-pinned Bun when regenerating the lockfile so CI can read its format.
Do not edit lockfiles by hand. Core dependency changes may also require refreshing
`desktop/bun.lock` with `bun install --ignore-scripts` after packing.

```sh
npm test
npm run test:e2e
npm run test:usability
npm run test:electron
npm run package
```

### Linux AppImage

```sh
npm run appimage
```

This rebuilds core and the app and creates `out/<timestamp>/AKM-Desktop-0.0.8-x86_64.AppImage`
(architecture-specific name) with a `.sha256` checksum beside it. The output is executable: copy
it wherever you prefer and double-click it to test. No installer, global AKM,
or background service is needed. It uses your normal AKM configuration.

Build on Linux with internet access for the pinned packaging tools on first use.
The app keeps Chromium sandboxing enabled; it does not silently disable it on
unsupported hosts. If FUSE is unavailable, run the AppImage with
`--appimage-extract-and-run` instead. The build does not publish anything or
automatically copy files to Downloads.

To launch it from your OS menu, open the AppImage and select **Settings →
Software → Add to application menu**. Close the download and use **AKM Desktop**
in your application menu afterward. This installs a stable per-user copy without
sudo and leaves the original download untouched. See [menu installation and
updates](docs/software.md).

Browser tests need Playwright Chromium (`npx playwright install chromium`).
Finish the build before starting tests; do not rebuild their shared output while
test servers are using it.
Native-window tests need a working desktop/display server. Test suites create
isolated synthetic bundles and never read your normal AKM configuration.
See [verification](docs/verification.md) for coverage and packaged-app checks.

`npm run package` writes an unsigned application for the current OS/architecture
under `out/<timestamp>/`. Keep the entire output directory together. Linux x64
is verified; macOS/Windows packaging and signing are not yet verified.

`npm run dev` starts a loopback-only Vite preview and prints a private launch
URL. It uses your configured AKM data unless you supply isolated environment
paths. Do not share that URL or expose the server through a proxy.

## AKM dependency

The generated, ignored `.core/` directory contains the ordinary CLI package built
and packed from this repository. Application code imports `akm-cli/workspace`,
not a global CLI or a sibling checkout. Native packaging installs this same
package and Desktop's frozen production dependency graph into a temporary stage.
The package retains AKM's license and notices. See [architecture](docs/architecture.md).

This source import is not a public Desktop release. Public GitHub installers,
release version alignment and migration from the existing private updater feed
are separate distribution work; no release or publishing workflow is added here.

## Deliberate limits

See [Software updates](docs/software.md) for private desktop distribution,
host CLI installation and harness plugin management.

No arbitrary filesystem operations, bulk retirement, skill-directory renaming,
proposal amendment/rebase, remote instances, or model-backed scheduling UI.
Secret/environment files have explicit masked viewing, create, edit and delete
actions; generated sessions remain read-only. Large result lists expose their limit and can be narrowed
with filters. This v1 is a foundation for human curation, not a claim that the
larger file-manager design is complete.

Files lists actual folders, including unindexed files, without rebuilding the
index. Supporting text files inside indexed skills can be viewed and edited;
other unindexed files are listed but not editable.
The editor preserves Markdown source/frontmatter; its preview supports a safe
Markdown subset, not an HTML editor or arbitrary embedded content.

Local source history depends on the bundle's Git history. Existing native
authentication, model configuration, hooks and task execution remain AKM/CLI
responsibilities.

## Related assets and file management

Open **Related assets** while reading a file. **Connections** follows AKM's
recorded asset links in both directions; it is not the retired LLM entity graph.
**Similar content** compares existing, compatible stored embeddings across all
enabled bundles or just the current one. Browsing makes no model request.
Scores describe indexed content, not a verdict that something is a duplicate.
Compare opens the existing inline comparison.

Use **More → Rename or move** for a single-file asset, or **Move skill to bundle**
for a complete skill. Preview shows every changed file. Supported link repairs
cover exact qualified refs and simple Markdown relative links in indexed files.
Package-internal links stay relative. Short refs, code, unusual syntax,
unindexed callers and installed schedules still require review. Renaming a task
does not change the installed scheduler; review and run `akm task sync` separately.
Existing usage/proposal history does not transfer to a renamed identity.

Move originals are retained under each affected bundle's
`.akm/desktop-moves/<operation>/`, alongside a restore map. Individual skill or
other source-file edits preserve their original under `.akm/desktop-edits/`.
Neither is searchable knowledge. No destination is overwritten; stale previews,
read-only bundles and symlink escapes are refused. Git and indexing follow AKM
policy, including embedding-provider calls on changed content when configured.

**More → Retire** immediately archives a single-file asset and refreshes the
index. There is no proposal queue, reason form or approval. **Undo retirement**
restores the exact files without overwriting newer work. The receipt shows the
native `.akm/memory-cleanup/archive/` location for later recovery; these manual
archives are retained, including after Undo. Memory parents carry their derived
twin. Existing links, pending proposals and installed schedules are not silently
rewritten or approved. Agent-proposed retirements still require review.
Skills cannot be retired piecemeal.

### Environment files, secrets and bundle names

In **Files**, open the arrow beside **New knowledge** and choose **Environment
file** or **Secret**. Choose a writable bundle, enter a filename and its text,
then create it. Open an existing file to **Edit** or **Delete** it, including
files not yet indexed. Env files use `.env`; secrets are files under `secrets/`.
Saving preserves existing newlines, uses private file permissions and follows
AKM's Git policy. Deletes confirm the exact path, remove its sensitive marker
and refresh the index. They have no Undo; existing Git history is unchanged.
Protected-file editing creates no recovery copies or browser-storage drafts.

In **Settings → Bundles & index → Manage**, choose **Rename bundle**, enter
the new name and preview the impact. AKM updates its configuration, indexed
references and operational state, and reconciles its task bindings. The folder
stays in place. References inside authored files and frozen workflow plans are
reported for manual review, not silently rewritten.
