# Software updates

Open **Settings → Software**.

## Add AKM Desktop to your application menu

In the Linux AppImage, select **Add to application menu**. Then close the
download and open **AKM Desktop** from your desktop environment's application
menu. No administrator password is needed and the original download is kept.

The button installs three per-user files:

- `~/.local/bin/akm-desktop.AppImage` — stable executable; native updates keep this filename.
- `$XDG_DATA_HOME/applications/dev.fwdslsh.akm-desktop.desktop` — menu entry.
- `$XDG_DATA_HOME/icons/hicolor/512x512/apps/dev.fwdslsh.akm-desktop.png` — icon.

An unset or relative `XDG_DATA_HOME` uses `~/.local/share`. Nothing is installed
until you click. No service, startup task, shell profile or AKM data is changed.
Menu integration is supported in the Linux AppImage, not development/unpacked
builds or other operating systems.

If you later open another download, **Replace menu copy…** asks for confirmation:
that download may be older than the installed copy. From the installed app,
**Repair menu entry** restores its entry/icon without copying the app over itself.
Finish a pending desktop update before installing a menu copy. Desktop cannot
close during installation. If the launcher does not appear immediately, reopen
the application menu; desktop environments normally notice the new entry.

## Updates and harness plugins

1. Connect desktop updates using a Gitea token with **read-only repository**
   access to the private fwdslsh/akm-desktop repo. The token is encrypted with
   the system keyring; without a keyring it stays in memory for this session.
2. Leave automatic downloads enabled to check at launch and every four hours.
   A verified update installs when you quit normally. Unsaved documents still
   prompt; a CLI/plugin installation must finish before the app can close.
3. Use **Install AKM CLI** if the host has none. The official release installer
   verifies checksums and installs to `~/.local/bin`, without sudo. Add this
   directory to your terminal PATH if absent; Desktop already searches it.
4. Use **Check CLI & plugins**, then **Update CLI & plugins**. These run
   `akm upgrade --check` and `akm upgrade`, including AKM's migration and
   compatibility handling. Desktop does not switch an existing installation's
   channel, force downgrades or replace a package-local CLI.
5. Install AKM for an existing Claude Code, Codex, OpenCode 1 or OpenCode 2
   harness using its native installer. New plugins can use Stable or Prerelease;
   an existing marketplace's channel stays unchanged. Claude/Codex hooks need
   Bun. Codex still requires native `/hooks` review: installation is not approval.
   Restart the harness to load a newly installed plugin.

The bundled engine runs the desktop workspace. The host CLI runs terminal jobs
and harness integrations. Updating the host CLI does not replace the bundled
engine; that moves with a desktop release. No CLI, plugin, harness, sign-in,
trust entry or scheduler is installed automatically at startup.

Self-installation currently supports only Linux AppImages. Unpacked and
development builds show that limitation rather than claiming to be updatable.
The old 0.2.0 build has no updater and needs a **one-time manual replacement**.
Subsequent private builds use monotonically increasing 0.0.x versions.

## Distribution boundary

This source import does not publish Desktop releases. The existing private-feed
client is retained for feature parity, but the private release publisher is not
part of this repository. No Gitea credential is needed to build or test Desktop.
Public GitHub installers, automatic-update feed migration and release workflow
integration remain separate work. Do not configure private updates in a public
distribution candidate.

Repository tokens never enter the build. The app stores update preferences in
Electron's userData directory, separately from AKM's configuration. Native
encrypted storage is required for persistence; plaintext keyring fallback is
refused. An inaccessible keyring requires unlocking it or re-entering the token.

## Verification

```sh
npm test
npm run test:e2e
npm run test:electron
AKM_DESKTOP_TEST_RUNTIME=/absolute/path/to/built.AppImage npm run test:updater
AKM_DESKTOP_TEST_LIVE_INSTALL=1 npm run test:host-install
AKM_DESKTOP_TEST_LIVE_PLUGINS=1 npm run test:plugin-install
```

The updater integration test uses an authenticated loopback feed and replaces
only a generated disposable copy. The optional host install test downloads the
official CLI into a generated temporary home. Neither changes your actual
installed application, CLI, plugins or AKM configuration. The optional plugin
integration test uses available host harness binaries with isolated homes and
configuration roots. It downloads real plugins, but performs no sign-in,
hook approval or model request.

The Software UI test exercises real authenticated server actions with synthetic
native command fixtures. It covers installation, upgrade receipts, unsupported
desktop updates, accessibility and viewport overflow. Plugin tests assert each
native command and verify its inventory afterward; they do not claim native
hook approval, sign-in or model-backed recall from merely installing a plugin.

## References

- [Electron updater v26 guide](https://www.electron.build/v26/docs/features/auto-update/)
- [AKM plugin installation](https://github.com/itlackey/akm-plugins#readme)
- [AKM official installer](https://github.com/itlackey/akm/blob/main/install.sh)
- [fhold per-user menu implementation](https://github.com/fwdslsh/fhold/blob/907ceb9427c1d1b5414870abf8d1b5132bc5facf/packages/electron/src/admin-desktop.ts)
- [Freedesktop Exec quoting](https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html)
