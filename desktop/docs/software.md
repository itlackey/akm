# Software

Open **Settings → Software**.

## Add AKM Desktop to your application menu

In the Linux AppImage, select **Add to application menu**. Then close the
download and open **AKM Desktop** from your desktop environment's application
menu. No administrator password is needed and the original download is kept.

The button installs three per-user files:

- `~/.local/bin/akm-desktop.AppImage` — stable executable.
- `$XDG_DATA_HOME/applications/dev.fwdslsh.akm-desktop.desktop` — menu entry.
- `$XDG_DATA_HOME/icons/hicolor/512x512/apps/dev.fwdslsh.akm-desktop.png` — icon.

An unset or relative `XDG_DATA_HOME` uses `~/.local/share`. Nothing is installed
until you click. No service, startup task, shell profile or AKM data is changed.
Menu integration is supported in the Linux AppImage, not development/unpacked
builds or other operating systems.

If you later open another download, **Replace menu copy…** asks for confirmation:
that download may be older than the installed copy. From the installed app,
**Repair menu entry** restores its entry/icon without copying the app over itself.
Desktop cannot close during installation. If the launcher does not appear immediately, reopen
the application menu; desktop environments normally notice the new entry.

## Updating Desktop

Desktop's version is the AKM version it embeds; it is built from the released `akm-cli`
package, in the same release. The app checks this repository's GitHub releases
(`itlackey/akm`) when it starts and every six hours, with no token and no other server.
A stable build follows stable releases only. A build of a stage release (alpha, beta, rc)
takes the newest alpha, beta or stable release; rc releases are installed by hand, because
electron-updater's GitHub provider confines an rc build to rc releases.

- **Linux AppImage and Windows:** the update downloads in the background and installs when
  you quit AKM Desktop. Software shows the state. A Linux build that is not an AppImage does
  not check for updates.
- **macOS:** Software says a newer version is available and links to its release page.
  macOS applies an update only to a signed app, so download and replace the app yourself.
- Set `AKM_DESKTOP_UPDATES=off` to turn the check off.

## Unsigned installers

The installers (Linux AppImage, macOS dmg and zip for Apple silicon, Windows NSIS for x64) are
not code-signed or notarized, because no signing certificate exists yet. No signing secret is
part of the build. What users see:

- **macOS** Gatekeeper blocks the first launch of a downloaded app. Control-click AKM Desktop,
  choose Open, and confirm; or remove the quarantine flag with `xattr -dr com.apple.quarantine`
  on the app. Intel Macs are not built.
- **Windows** SmartScreen shows "Windows protected your PC". Choose More info, then Run anyway.
- **Linux** has no signing prompt. Check the `.sha256` file beside the download.

Signing would plug into `scripts/package.mjs`: a macOS identity and notarization settings
(`mac.identity`, `mac.notarize`) and a Windows signing certificate (`win.signtoolOptions`), with
their credentials supplied by the release job's environment. Once macOS is signed,
`canInstall` in `electron/updater.mjs` becomes true there and macOS updates install in place.

## Engine versions

AKM Desktop runs its built-in engine; your terminal and harness plugins run the host `akm`.
Both read the same data directory. Software shows both versions and says what to do when they
differ:

- **Host older than Desktop:** if Desktop's engine changed the index layout, the host CLI asks
  you to upgrade. Use **Update CLI & plugins**.
- **Host newer than Desktop:** Desktop refuses an index layout it does not know
  (`INDEX_SCHEMA_INCOMPATIBLE`) and tells you to update AKM Desktop. Update CLI & plugins is
  held back while the latest release is newer than Desktop's engine, so a host upgrade never
  leaves Desktop behind.

## First-run setup

A computer with no library shows **Set up akm on this computer** on Home; **Settings → Bundles & index** and
**Settings → Software** have **Run setup again**, and an error that says the library is missing links to `/setup`.
Setup keeps no "done" flag: every step shows what is true now, so running it again only offers what is still missing.
Nothing runs until you press a button.

1. **Your library.** The folder where akm keeps what agents learn (`~/akm` unless you choose another) and the
   official starter bundle (`itlackey/akm-stash`), ticked, which downloads from GitHub. Creating the library is
   `akm setup --yes` (`setup.apply`); the starter bundle is `bundles.add`. A failed download does not undo the library;
   **Retry** repeats it.
2. **Connect your agents.**
   - **akm command-line tool**, ticked when it is missing: it installs akm of Desktop's own release to
     `~/.local/bin`, so that an agent without a plugin can use akm from a shell. When one is installed, setup shows its
     version, and offers **Update CLI & plugins** only when it is older than the engine built into the app.
   - One card per harness found (Claude Code, Codex, OpenCode, OpenCode 2), with the installed plugin's version. The
     plugin installs from the channel Desktop is on: a stable Desktop installs the stable plugin, and a prerelease
     Desktop the `next` one. Plugins share akm's major and minor version and number their builds on their own, so a
     plugin built for another minor is flagged. OpenCode resolves its plugin's exact version when it starts, so its card
     shows the package it configured.
   - **Let akm use this agent for learning** is off unless you tick it, because background learning runs that agent's
     model on your quota. `akm setup --yes` would enable every program it finds; `setup.apply` keeps only those you
     name.
   - **Bun.** The Claude Code and Codex hooks are TypeScript files that the harness starts with `bun`; the standalone
     akm CLI does not provide a `bun` command, so Bun is the plugin's own runtime, not just a way to get akm. When Bun
     is missing the card shows Bun's official install command with **Copy** and **Check again**. Desktop never runs
     Bun's installer. OpenCode plugins carry their own akm and need no Bun from you.
Desktop's CLI install is Linux and macOS; on Windows run the `install.ps1` of the release yourself.

## Host CLI and harness plugins

1. Use **Install AKM CLI** if the host has none. The official release installer
   verifies checksums and installs to `~/.local/bin`, without sudo. Add this
   directory to your terminal PATH if absent; Desktop already searches it.
2. Use **Check CLI & plugins**, then **Update CLI & plugins**. These run
   `akm upgrade --check` and `akm upgrade`, including AKM's migration and
   compatibility handling. Desktop does not switch an existing installation's
   channel, force downgrades or replace a package-local CLI.
3. Install AKM for an existing Claude Code, Codex, OpenCode 1 or OpenCode 2
   harness using its native installer. New plugins can use Stable or Prerelease;
   an existing marketplace's channel stays unchanged. Claude/Codex hooks need
   Bun. Codex still requires native `/hooks` review: installation is not approval.
   Restart the harness to load a newly installed plugin.

The bundled engine runs the desktop workspace. The host CLI runs terminal jobs
and harness integrations. Updating the host CLI does not replace the bundled
engine; that moves with a Desktop download. No CLI, plugin, harness, sign-in,
trust entry or scheduler is installed automatically at startup.

## Verification

```sh
npm test
npm run test:e2e
npm run test:electron
AKM_DESKTOP_TEST_LIVE_INSTALL=1 npm run test:host-install
AKM_DESKTOP_TEST_LIVE_PLUGINS=1 npm run test:plugin-install
```

The optional host install test downloads the
official CLI into a generated temporary home. It does not change your actual
installed application, CLI, plugins or AKM configuration. The optional plugin
integration test uses available host harness binaries with isolated homes and
configuration roots. It downloads real plugins, but performs no sign-in,
hook approval or model request.

The Software UI test exercises real authenticated server actions with synthetic
native command fixtures. It covers installation, upgrade receipts, the
update and engine-version notes, accessibility and viewport overflow. Plugin tests assert each
native command and verify its inventory afterward; they do not claim native
hook approval, sign-in or model-backed recall from merely installing a plugin.

## References

- [AKM plugin installation](https://github.com/itlackey/akm-plugins#readme)
- [AKM official installer](https://github.com/itlackey/akm/blob/main/install.sh)
- [fhold per-user menu implementation](https://github.com/fwdslsh/fhold/blob/907ceb9427c1d1b5414870abf8d1b5132bc5facf/packages/electron/src/admin-desktop.ts)
- [Freedesktop Exec quoting](https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html)
