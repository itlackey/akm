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
  Follow recorded connections, compare stored cosine similarity, organise files
  and folders in the tree like a file manager (rename, move, copy, delete, new
  folder; a move is a rename on disk and the asset keeps its history), copy whole
  skills between bundles and edit their `SKILL.md`. Create, compare, copy,
  inspect history and record feedback. Diffs start inline.
  Environment files and secrets open masked; use **Show / Hide** to read them.
  Create, edit and delete them directly; values and edits stay in memory only,
  never in retained drafts. Leaving unsaved edits asks before discarding them.
- **Review:** inspect proposed changes and evidence; accept, reject, reopen,
  or revert when AKM supports it. Batch decisions retain individual outcomes.
- **Activity:** separate Health, Runs, Usage & retrieval, Improve impact and
  Source history views. Charts retain their data tables, periods and drilldowns;
  observations are not quality or causality scores. Runs has an outcome bar per kind of run, a view of each improve, task and workflow run, and a timeline of recorded
  runs and each workflow run's trace, Replay plays a period's activity over the
  library map, Library has a map of every asset and link, and an asset's Related
  tab a map of its own links: see [visualizations](docs/visualizations.md).
- **Settings:** full bundle management and grouped, validated settings with
  scoped saves. Changing one settings group does not discard another's edits.
  Rename a bundle through **Manage → Rename bundle** without moving its folder.
  **Configuration → Embeddings** sets the embedding model for semantic search: the built-in embedder (where akm
  offers it), a model served by the default connection, or a remote endpoint with its model and key, saved as `akm setup` saves them. A
  `$VAR` key is written as the block's `apiKey`; a typed key goes to `credentials.json` for that endpoint and is never
  shown again. Changing the model makes the next `akm index` embed each entry again.
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

`npm run dev` starts a loopback-only Vite preview at `http://127.0.0.1:5173`. It logs in with
`AKM_WEB_SECRET` when that is set, otherwise with a secret it makes and prints. It uses your configured AKM data
unless you supply isolated environment paths. Do not share that secret.

## Run it on a server

AKM Desktop needs none of this. It starts the web process on `127.0.0.1` on a free port, with a secret it makes
for that launch, and shows it in its own window. There is nothing to configure and no login to see, and nothing in
`experimental.web` changes how it starts.

`akm-web` is the same web process alone, with no Electron and no display, for a server or an Assistant container. It
replaces `akm ui` for headless installs and manages the library of the user that runs it. Everything below is
**Advanced**.

### Advanced: a host, programs and embedding

This is for people who understand origins, proxies, cookies and TLS. Listening on another host, or showing the UI
inside another app, may need infrastructure akm does not provide: TLS, a reverse proxy, DNS and network rules. Over
plain HTTP the secret and any revealed secret cross the network unencrypted.

`akm-web` needs one secret. There are three ways to use it:

- A **person** types it into the login form and gets a session cookie.
- A **program that forwards requests** (a proxy, another app's server) sends it in a header on each request.
- A **program that wants a browser logged in without typing** trades it for a one-time login link.

Nothing else grants access, and `akm-web` prints no credential.

#### Run it on a host or in a container

```sh
npm install -g akm-web   # Node 22.18 or later
export AKM_WEB_SECRET="$(openssl rand -hex 32)"
akm-web --host 0.0.0.0 --port 4444 --origin http://my-server:4444
```

The secret is at least 32 characters. Give it as the environment variable `AKM_WEB_SECRET`, or as
`experimental.web.secret` in the akm config, which holds a reference (`$NAME`, `${NAME}` or `${secrets/<name>}`),
never the secret itself. When both are set, `AKM_WEB_SECRET` wins. The secret is read once at startup and removed from
the process environment, so the CLI commands the server runs do not inherit it. To rotate it, change it and restart.

The other settings live under `experimental.web` in the akm config
([reference](../docs/reference/configuration.md#experimental-web-settings)) and are Experimental: names and behaviour
may change in 0.11. Flags apply to one run and override the config key of the same name.

| Key | Flag | Meaning | Default |
| --- | --- | --- | --- |
| `host` | `--host <addr>` | Address to listen on. | `127.0.0.1` |
| `port` | `--port <n>` | Port to listen on. | a free port |
| `origin` | `--origin <url>` | The address the browser uses: `http(s)://host[:port]`, no path. It differs from the listen address behind a Docker port mapping or a proxy. It is required with a wildcard host (`0.0.0.0`, `::`). An `https` origin marks the session cookie `Secure`. | the bound address |
| `secret` | | Reference to the secret. | none |
| `allowedHosts` | | Extra `Host` names to accept, for a proxy that reaches `akm-web` under a private name. A name matches with or without its port. | none: only the origin's host |
| `frameParents` | | Origins allowed to show the UI in a frame. | none: framing is denied |
| | `--open` | Open the UI in the default browser. Nothing opens without it. | |
| | `--auto-login` | With `--open`: the browser arrives logged in, through a one-time login link that is not printed. Without it, the browser shows the login form. | |

With `--open --auto-login` the one-time code is part of the address passed to the browser opener, so it is briefly
visible in the process list. It works once and expires after 60 seconds.

`akm-web` exits with status 2 and a message that says what to set when there is no secret, when the secret is shorter
than 32 characters, when `--auto-login` is given without `--open`, or when the origin has a path, query or fragment.

When the server answers authenticated requests it prints one line, `{"type":"ready","origin":"..."}`. It has no URL and
no credential. Open the origin and type the secret into the login form. A failed `--open` prints one line to stderr
and the server keeps running. On `SIGTERM` or `SIGINT` the server stops accepting connections, waits up to 10 seconds
for requests in flight, closes what remains and exits 0.

In Docker, publish the port, pass the secret and name the address the browser will use:

```sh
docker run -p 4444:4444 -e AKM_WEB_SECRET my-image akm-web --host 0.0.0.0 --port 4444 --origin http://localhost:4444
```

##### Sessions

The login form posts the secret in the request body and receives a session: a random identifier in an `HttpOnly`,
host-only cookie. The secret is never in a cookie. Sessions are kept in memory, in a bounded table, and end after 8
hours without use, on logout (the "Log out" button in the page's top bar, which calls `POST /api/session/logout`), or when the server
restarts. "Log out" is shown only to a person with a session cookie, not in AKM Desktop or behind a proxy that sends the
header. Logout ends your own session only; there is no way to end someone else's short of a restart. The cookie name carries the port, so two instances on one host do not share
sessions.

##### Checks that are always on

None can be turned off, whichever way you come in.

- `Host` must be the origin's host or one of `allowedHosts`; anything else gets `403`.
- Every write (any method other than `GET` and `HEAD`) must carry an `Origin` equal to the configured origin. This holds for
  requests that carry the header too.
- No CORS, and `Cache-Control: no-store`.

#### Programs

A program sends the secret in an `Authorization: Bearer <secret>` header on each request. No session is made, so it
needs no cookie, and a restart does not log it out. A request that carries an `Authorization` header must carry the
right secret: a wrong one is refused even when the request also has a valid session cookie.

**A program must send `Origin` itself on every write.** A browser does this by itself; a server does not. Set
`Origin` to the configured origin. With no `Origin`, or another one, the write is refused with `403`.

- `GET /api/session` returns `{"ok":true,"active":<boolean>,"session":<boolean>}`; `session` is true when the request
  was allowed by a session cookie rather than the header (the UI shows "Log out" only then). It tells "listening" from "ready": until the server
  answers authenticated requests, every request gets `503` with code `STARTING`. `active` is true while a request
  other than this one is being served or a host-tool operation is running, so a launcher can ask before an idle
  shutdown.
- `POST /api/session/link`, with the header and `Origin`, returns `{"url":"<origin>/?login=<code>"}`. Opening that
  address in a browser sets a session cookie and shows the UI. A link works once and expires after 60 seconds. The
  address has no path: an app that serves the UI under a path puts that path in front (`<origin>/akm/?login=<code>`).
- `POST /api/session/logout` ends the caller's session and clears its cookie.

```sh
curl -X POST http://my-server:4444/api/session/link \
  -H "Authorization: Bearer $AKM_WEB_SECRET" \
  -H "Origin: http://my-server:4444"
```

A request without a session or the header gets the structured `401`; a browser navigation gets the login form.

#### Show the UI inside another app

There are two ways. Both trust whoever holds the secret with the owner's full authority (see
[Limits](#limits-stated-plainly)).

##### Through the app's own server, under a path

The browser talks only to the app, and the app forwards. The assistant takes no public traffic.

```
browser --https--> app (public)  /akm/...  --private network--> akm-web (not public)
                   - checks its own signed-in user
                   - removes the /akm prefix
                   - adds Authorization: Bearer <secret>
                   - forwards the request and streams the response back
```

The proxy removes the path before forwarding, replaces any `Authorization` header from the browser with its own, and
leaves the browser's `Origin` as it is. The app decides who may reach which assistant: `akm-web` trusts every request
that carries the secret. The UI's links and API calls work from whatever path it is served under; there is no setting
for the path.

Configure the assistant with:

- `origin`: the app's public origin, because that is where the browser is. Writes are checked against it.
- `allowedHosts`: the private name the app calls it by, unless the proxy sends the origin's host.
- `frameParents`: the app's origin, if the page shows the UI in a frame.
- `secret`: usually `$AKM_WEB_SECRET`, filled from the platform's secret store.

The user is never prompted and their browser never holds an akm credential. Because the header needs no session,
restarts and more than one replica do not log anyone out.

##### In a frame pointed at the server

For setups where the user's browser can reach the assistant. Set `frameParents` to the page's origin. Then the
response allows exactly those origins (`Content-Security-Policy: frame-ancestors`, with no `X-Frame-Options`); with no
`frameParents`, framing is denied.

- Without automatic login, the frame shows the login form and the user types the secret.
- With automatic login, the app's server, holding the secret, asks for a one-time login link (sending `Origin`) and
  uses it as the frame's address.

If the page and the assistant are on the same site (the same machine, or one parent domain), this works over `http`
or `https`. On different sites the origin must be `https`: the cookie then becomes `SameSite=None; Secure;
Partitioned`, which is what a browser needs before it sends a cookie inside a frame on another site. It still depends
on the browser accepting it, and some browsers block cookies in frames from another site, so this will not work for
everyone. Without `frameParents` the cookie is `SameSite=Strict`.

#### Example: Azure Container Apps

An assistant and a broker app (the one the user's browser talks to) in one Container Apps environment. The platform
gives the broker only the hostname it assigns.

- The assistant app has internal ingress only, with `host` set to `0.0.0.0`. No public traffic reaches it.
- The broker app has external ingress and reaches the assistant by its internal address in the same environment.
- On the assistant, `origin` is the broker's public origin and `allowedHosts` holds the assistant's internal name.
- One Container Apps secret is given to both apps, as `AKM_WEB_SECRET` on the assistant and in the broker's
  `Authorization` header.
- The platform's probe is a TCP probe, which shows only that the port is open. The broker, which holds the secret,
  calls `GET /api/session` before it shows the UI.

Serving under a path, and the arrangement of different internal and public host names, are checked by tests with a
local proxy (`tests/path-prefix.test.mjs`, `tests/web-access.test.mjs`). The Azure arrangement itself has not been run
by the project: the `Host` value internal ingress passes to the container, and whether the broker's proxy streams
responses and leaves `Origin` untouched, are for you to confirm.

#### Limits, stated plainly

- Anyone who gets in has the owner's full authority over that assistant's library: editing files, revealing secrets,
  installing host tools.
- A user who is not shown the secret can still find it, with that authority. Keeping the assistant off the public
  network is what stops them using it directly.
- An allowed frame parent is trusted with the user's clicks, because it can draw over the frame.
- Some browsers block cookies in frames from another site, so a frame on another site will not work for everyone.
- Logout ends a person's own session. There is no way to end someone else's, short of a restart.
- Over plain HTTP the secret and any revealed secret cross the network unencrypted. Use a private network or a TLS
  proxy that keeps the `Host` header (or lists its name in `allowedHosts`).
- akm provides no TLS, no user accounts and no roles.

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

No bulk retirement, proposal amendment/rebase, or model-backed scheduling UI.
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

### Organising files

In **Files**, every file and folder has the same menu: right-click it, press the
menu key (or Shift+F10) on it in the tree, or use the **Actions for …** button on
its row. It offers New file and New folder (on a folder), Rename, Move to…, Copy
to…, Retire, Delete and, in the desktop app, Reveal in file manager. A control is
offered when AKM says the action is allowed for that file, and shown disabled with
AKM's sentence when it is not (a read-only bundle, a bundle of another adapter, a
protected file, `.git/`, a skill's `SKILL.md`), so no control fails after the click.

- **Rename** is inline (F2 in the tree). **Move to…** and **Copy to…** open a
  folder picker that is the same tree; dragging a file or folder onto a folder is
  the same move, and asks once, naming both. A move or rename is a plain rename on
  disk followed by AKM's index (`bundles.index`), which pairs the file with the
  asset it was: its usage, feedback and proposal history go with it, and the open
  page follows the file to its new place. A copy is a new file.
- Links in other assets that still name the old place are reported by AKM; a
  notice counts them and **Update N links** rewrites exactly those, after you
  choose it. A read-only bundle is counted and not written, with AKM's reason.
- **New** names what AKM says the folder holds (New lesson, New workflow, New
  file) and makes it in this folder of this bundle, started with the text its type
  starts with, then opens the editor. New folder makes a folder. **Write this up**
  (a search that found nothing) is the same create, for knowledge, in AKM's write
  target.
- **Copy to…** is one operation, from the tree and from an asset's More menu: AKM's
  `assets.copyEntry` copies a file or folder to the folder you choose, staged, indexed
  and committed by the bundle's policy, and records an asset's origin in `sources`.
- **Delete** removes an empty folder or a file that is no asset after one
  confirmation. An asset is retired, as below.
- The list shows each entry's size and modified time. Git bundles show how many
  files a commit would take (`akm sync`) above the files, with a **Commit** button;
  nothing commits by itself.

Reading and editing show a file's **Properties**: the frontmatter under the title
for every kind, and in the editor as fields for the keys AKM knows for the type,
a row for every other key, add and remove, with a **Text** switch for the whole
file. Changes are applied by AKM (`documents.applyFrontmatter`), so unknown keys,
quoting and the body stay as written. A script reads as code, a task as YAML, and
**Source** is the whole file. Save asks AKM to check the text first: findings are
listed beside the editor with their lines; text AKM could not read as the asset
stops the save, with **Save anyway**, and the file is then shown as not indexed
with AKM's reason. Installed schedules are not changed when a task moves or is
retired: run `akm doctor scheduler sync`. Edits and copies follow AKM's write, Git
and indexing policy. Desktop keeps no backup copies of its own.

**More → Retire** immediately retires a single-file asset. It is recorded as an
accepted retirement, so it appears in Review and Activity and follows the same
lifecycle as an agent-proposed one: the archive is purged after the grace
period at the next improve run (git-backed bundles). There is no reason form or
approval step. **Undo retirement** reverts that proposal, moving the exact files
back without overwriting newer work; you can also revert it later from Review.
Memory parents carry their derived twin. Existing links, pending proposals and
installed schedules are not silently rewritten or approved. Agent-proposed
retirements still require review. Skills cannot be retired piecemeal; a skill moves as its folder.

### Environment files, secrets and bundle names

In **Files**, open the top-level `env/` or `secrets/` folder and choose **New environment file** or **New secret** (AKM says those folders take them). Choose a writable bundle, enter a filename and its text,
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
