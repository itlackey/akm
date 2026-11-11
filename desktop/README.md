# AKM Desktop

A local workspace for reviewing and maintaining what your agents know.
SvelteKit supplies the UI and server-side routes; Electron supplies the desktop
window and Node runtime. Existing `akm-cli/workspace` functions own every AKM
operation. This app does not implement another asset store or proposal engine.

Linux development build. The task-first v1 includes:
website-like search and reading, a bundle-folder workspace for curation, a focused
proposal review desk, and separate technical views for health and metrics.
The Attention desk Home page provides a compact starting point for those workflows.
The compact top bar and established AKM palette remain. This does not claim
that the larger asset-manager design is complete.
Desktop's version is the version of the AKM it embeds (one version, one release); the commit ID is shown separately.
The same web process also runs on a server or in a container as `akm-web` (see [Run it on a server](#run-it-on-a-server)).
See [verification](docs/verification.md) for evidence and limits.

## Use it

The packaged app includes its own AKM dependency and runtime. On Linux, launch
the executable `.AppImage`; on macOS open the dmg and drag AKM Desktop to Applications; on Windows
run the installer. Alternatively launch `akm-desktop` from an unpacked application directory. No separate Node, Bun, or global AKM installation is
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
  single-file assets (a copy, then a retirement of the original), copy whole
  skills between bundles and edit their `SKILL.md`. Create, compare, copy,
  inspect history and record feedback. Diffs start inline.
  Environment files and secrets open masked; use **Show / Hide** to read them.
  Create, edit and delete them directly; values and edits stay in memory only,
  never in retained drafts. Leaving unsaved edits asks before discarding them.
- **Review:** inspect proposed changes and evidence; accept, reject, reopen,
  or revert when AKM supports it. Batch decisions retain individual outcomes.
- **Activity:** separate Health, Runs, Usage & retrieval, Improve impact and
  Source history views. Charts retain their data tables, periods and drilldowns;
  observations are not quality or causality scores. Runs has a timeline of recorded
  runs, and an asset's Related tab a map of its links: see
  [visualizations](docs/visualizations.md) for their limits and what is not built yet.
- **Settings:** full bundle management and grouped, validated settings with
  scoped saves. Changing one settings group does not discard another's edits.
  Rename a bundle through **Manage → Rename bundle** without moving its folder.
  **Software** manages the host CLI and harness plugins.

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

Use Bun 1.3.14 (the CI-pinned toolchain), Node 22.18+ (Node 24 LTS tested),
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
the test commands below instead. A first-time user is taken through setup (`/setup`):
the library, the akm CLI and the harness plugins, then a check that an agent reaches the
library ([Software](docs/software.md#first-run-setup)).

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
npm run dist
```

This rebuilds core and the app and creates `dist/AKM-Desktop-<akm version>-x86_64.AppImage`
(architecture-specific name) with a `.sha256` checksum and the `latest-linux.yml` update
metadata beside it. On macOS it builds a dmg and a zip, on Windows an NSIS installer, the same
way. Releases come from the release workflow, not from here: `node scripts/package.mjs --release`
refuses a dirty tree and an engine that is not the released tarball. The output is executable: copy
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
under `out/<timestamp>/`. Keep the entire output directory together. `npm run smoke`
starts the newest package headless and checks that it answers with the right version.
CI packages and starts Desktop on Linux, macOS and Windows; the installers are unsigned.

`npm run dev` starts a loopback-only Vite preview and prints a private launch
URL. It uses your configured AKM data unless you supply isolated environment
paths. Do not share that URL.

## Run it on a server

`akm-web` is the web process alone, with no Electron and no display, for a server or an Assistant container. It
replaces `akm ui` for headless installs and manages the library of the user that runs it.

```sh
npm install -g akm-web   # Node 22.18 or later
akm-web --host 0.0.0.0 --port 4444 --origin http://my-server:4444
```

- `--host <addr>` is the address to listen on (default `127.0.0.1`).
- `--port <n>` is the port (default: a free one).
- `--origin <url>` is the address your browser uses, which differs from the listen address behind a Docker port
  mapping or a proxy (default `http://<host>:<port>`). It is required with a wildcard `--host` (`0.0.0.0`, `::`); without
  it the command exits with an error. An `https` origin marks the session cookie `Secure`.

When started from a terminal on a machine with a screen it also opens that URL in the default browser. It does not when
there is no TTY, an SSH session, CI, a container, or (on Linux) no `DISPLAY` or `WAYLAND_DISPLAY`; there is no flag for it.
A failed open prints one line to stderr and the server keeps running.

It prints one JSON line, `{"type":"ready","url":"...","origin":"..."}`; open `url`. The URL carries the session token
and the browser keeps it in a cookie. The token, Host and Origin checks are always on and are compared with `--origin`.

In Docker, publish the port and pass the address the browser will use:

```sh
docker run -p 4444:4444 my-image akm-web --host 0.0.0.0 --port 4444 --origin http://localhost:4444
```

Whoever holds the token has the owner's full authority over that library: they can edit bundle files, reveal
secrets and install host tools. Over plain HTTP the token and any revealed secret cross the network unencrypted, so use a
private network or a TLS proxy that keeps the `Host` header. Desktop does not add TLS or a login.

## AKM dependency

The generated, ignored `.core/` directory contains the ordinary CLI package built
and packed from this repository. Application code imports `akm-cli/workspace`,
not a global CLI or a sibling checkout. Native packaging installs this same
package and Desktop's frozen production dependency graph into a temporary stage.
The package retains AKM's license and notices. See [architecture](docs/architecture.md).

Desktop's version is the AKM version it embeds. The release workflow builds Desktop on
Linux, macOS and Windows from the released tarball and attaches the installers to the AKM
release; the app updates itself from those GitHub releases (see [Software](docs/software.md)).

## Deliberate limits

See [Software](docs/software.md) for the application menu, host CLI
installation and harness plugin management.

No bulk retirement, skill-directory renaming,
proposal amendment/rebase, or model-backed scheduling UI.
Secret/environment files have explicit masked viewing, create, edit and delete
actions; generated sessions remain read-only. Large result lists expose their limit and can be narrowed
with filters. This v1 is a foundation for human curation, not a claim that the
larger file-manager design is complete.

Files lists actual folders, including unindexed files, without rebuilding the
index. Any text file in an enabled bundle, including a skill's supporting files,
can be viewed with plain file operations, and edited in a bundle AKM writes to
(the edit refuses a file that changed since it was opened, and a link out of the
bundle); `env/` and `secrets/`
have their own masked view. Saving asks AKM to refresh the index for that file.
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

Use **More → Rename or move** for a single-file asset. It copies the asset to
the chosen bundle and name (AKM's copy, which never overwrites and records the
original in the copy's `sources`), then retires the original, so the original
is recoverable from Review. Links and refs to the old name are not rewritten;
`akm lint` reports them. Installed schedules are not changed: after moving a
task, run `akm task sync`. Existing usage/proposal history does not transfer to
the new identity. Skills can be copied (**Copy to bundle**) but not moved.
Edits and copies follow AKM's write, Git and indexing policy, including
embedding-provider calls on changed content when configured. Desktop keeps no
backup copies of its own.

**More → Retire** immediately retires a single-file asset. It is recorded as an
accepted retirement, so it appears in Review and Activity and follows the same
lifecycle as an agent-proposed one: the archive is purged after the grace
period at the next improve run (git-backed bundles). There is no reason form or
approval step. **Undo retirement** reverts that proposal, moving the exact files
back without overwriting newer work; you can also revert it later from Review.
Memory parents carry their derived twin. Existing links, pending proposals and
installed schedules are not silently rewritten or approved. Agent-proposed
retirements still require review. Skills cannot be retired piecemeal.

### Environment files, secrets and bundle names

In **Files**, open the arrow beside **New knowledge** and choose **Environment
file** or **Secret**. Choose a writable bundle, enter a filename and its text,
then create it. Open an existing file to **Edit** or **Delete** it, including
files not yet indexed. Env files use `.env`; secrets are files under `secrets/`.
Saving preserves existing newlines, uses private file permissions and follows
AKM's Git policy. Deletes confirm the exact path, remove its sensitive marker
and leave the index to `akm index`, as the CLI does. They have no Undo; existing Git history is unchanged.
Protected-file editing creates no recovery copies or browser-storage drafts.

In **Settings → Bundles & index → Manage**, choose **Rename bundle**, enter
the new name and preview the impact. AKM updates its configuration, indexed
references and operational state, and reconciles its task bindings. The folder
stays in place. References inside authored files and frozen workflow plans are
reported for manual review, not silently rewritten.
