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

**Desktop updates** on the Software page chooses the release line it follows: **Stable
releases**, or **Stable and prerelease releases** (alpha and beta). The choice is saved with
Desktop's preferences (`akm-desktop/preferences.json` under the config directory) and a change
checks again at once. Until you choose, the line is the stage of the embedded version: a
stable build follows stable releases only, a build of a stage release (alpha, beta, rc)
follows prereleases and stable releases. Desktop never replaces itself with an older
release, so a prerelease build set to stable stays until the next stable release.
Prereleases are followed as electron-updater's `alpha` channel: it takes the newest alpha,
beta or stable release and skips rc releases, so an rc is installed by hand from its release
page (the library's own rule, which the channel overrides, would confine an rc build to rc
releases).

- **Linux AppImage and Windows:** the update downloads in the background and installs when
  you quit AKM Desktop. Software shows the state, and says when a download, not the check,
  failed. A Linux build that is not an AppImage does not check for updates, and Software says
  so.
- **macOS:** Software says a newer version is available and links to its release page.
  macOS applies an update only to a signed app, so download and replace the app yourself.
- Set `AKM_DESKTOP_UPDATES=off` to turn the check off; Software says that it is off. A
  development run never checks, and says that too.

## Unsigned installers

The installers (Linux AppImage, macOS dmg and zip for Apple silicon, Windows NSIS for x64) are
not code-signed or notarized, and akm does not plan to sign or notarize the macOS or Windows
packages. No signing secret is part of the build. What users see:

- **macOS** Gatekeeper blocks the first launch of a downloaded app. Control-click AKM Desktop,
  choose Open, and confirm; or remove the quarantine flag with `xattr -dr com.apple.quarantine`
  on the app. Intel Macs are not built.
- **Windows** SmartScreen shows "Windows protected your PC". Choose More info, then Run anyway.
- **Linux** has no signing prompt. Check the `.sha256` file beside the download.

Because macOS applies an update only to a signed app, Desktop on macOS reports a new version
and links to its release page; download and replace the app yourself.

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
   `akm bundle create` (`setup.apply`); the starter bundle is `bundles.add`. A failed download does not undo the library;
   **Retry** repeats it.
2. **Connect your agents.**
   - **akm command-line tool**, ticked when it is missing: it installs akm of Desktop's own release to
     `~/.local/bin` (`%LOCALAPPDATA%\akm` on Windows), so that an agent without a plugin can use akm from a shell. When one is installed, setup shows its
     version, and offers **Update CLI & plugins** only when it is older than the engine built into the app.
   - One card per harness found (Claude Code, Codex, and OpenCode or OpenCode 2: the same `opencode` program, told
     apart by its version), with the installed plugin's version. The plugin installs from the channel chosen on
     Settings → Software (**New plugin channel**); until one is chosen, the channel Desktop is on: a stable Desktop
     installs the stable plugin, and a prerelease Desktop the `next` one. Plugins share akm's major and minor version
     and number their builds on their own, so a plugin built for another minor is flagged. OpenCode resolves its
     plugin's exact version when it starts, so its card shows the package it configured. The restart note is shown
     only for a plugin this run installed.
   - **Let akm use this agent** (ticked) enables the agent in akm's config (`akm setup --yes --harness=<agents>` through
     `setup.apply`) so that `akm agent` and tasks can run on it. The first agent enabled is the default harness, so
     several never leave the default ambiguous. Enabling does not turn learning on: while learning is off, setup writes
     off with it, so the agent takes none of akm's learning calls.
   - **Let akm learn in the background** is a separate choice, off unless you turn it on, because learning (improve,
     judging, extraction) uses model quota. Off writes the one host-wide switch (`improve.enabled: false`), which stops `akm improve` and the plugins' end-of-session `akm proposal extract`; the schedule is left alone. Turned on, it removes the switch (and the seven per-process switches earlier Desktop versions wrote),
     ensures the `improve` task exists and is enabled on every save (adding it from akm's template when the library has none) and asks where to run:
     **akm itself** (the default: a model reached through a connection, not an agent program; `improve.connection`) or
     any enabled agent (`improve.harness`), with akm's own note on whether that agent can be limited to reading and
     searching (a warning when it cannot). akm itself needs a connection: enter its endpoint, model and the NAME of the
     variable holding its key (never the key); with none configured and none entered it cannot be chosen. Turning
     learning on removes every `enabled: false` of those processes, a person's own included, because the config does not
     say who wrote it. The result reports what akm says afterwards. Learning reads on wherever akm's model calls could
     run with nothing switched off, scheduled or not (an only agent akm made its default harness, with no connection,
     takes them at every session end), so that state is shown, not hidden.
   - **Bun.** The Claude Code and Codex hooks are TypeScript files that the harness starts with `bun`; the standalone
     akm CLI does not provide a `bun` command, so Bun is the plugin's own runtime, not just a way to get akm. When Bun
     is missing the card shows Bun's official install command with **Copy** and **Check again**. Desktop never runs
     Bun's installer. OpenCode plugins carry their own akm and need no Bun from you.
3. **Try it.** A real search of the new library, then one line per connected harness to paste into it. Desktop counts
   the searches akm records for today and says so only when that count rises; it cannot tell which program searched, so
   check one harness at a time. After two minutes without a search it lists what to check (restart the harness, trust
   the Codex hooks, Bun on the harness's PATH).

## Host CLI and harness plugins

1. Use **Install AKM CLI** if the host has none. The official release installer
   verifies checksums and installs without sudo or an administrator: `install.sh` to
   `~/.local/bin` on Linux and macOS (add it to your terminal PATH if absent; Desktop
   already searches it), and on Windows `install.ps1`, run as
   `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`, to `%LOCALAPPDATA%\akm`,
   which it adds to your user PATH.
2. Use **Check CLI & plugins**, then **Update CLI & plugins**. These run
   `akm upgrade --check` and `akm upgrade`, including AKM's migration and
   compatibility handling. Desktop does not switch an existing installation's
   channel, force downgrades or replace a package-local CLI.
3. Install AKM for an existing Claude Code, Codex, OpenCode 1 or OpenCode 2
   harness using its native installer. OpenCode 1 and 2 are one row, labelled by the
   installed version. **New plugin channel** (Stable or Prerelease) is remembered with
   Desktop's preferences and is what first-run setup installs too; until chosen it is
   Desktop's own stage. An existing marketplace's channel stays unchanged, and once
   **Check CLI & plugins** has run each installed plugin's row says which channel it
   follows (Stable, Prerelease or Pinned), as `akm upgrade --check` read it. Claude/Codex
   hooks need Bun. Codex still requires native `/hooks` review: installation is not approval.
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
