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

Desktop does not update itself. Replace the AppImage (or the menu copy) with a
newer download. Desktop's version is the AKM version it embeds, and a distributable
AppImage is built only from a clean tree at that version's release tag.

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
replace-the-AppImage note, accessibility and viewport overflow. Plugin tests assert each
native command and verify its inventory afterward; they do not claim native
hook approval, sign-in or model-backed recall from merely installing a plugin.

## References

- [AKM plugin installation](https://github.com/itlackey/akm-plugins#readme)
- [AKM official installer](https://github.com/itlackey/akm/blob/main/install.sh)
- [fhold per-user menu implementation](https://github.com/fwdslsh/fhold/blob/907ceb9427c1d1b5414870abf8d1b5132bc5facf/packages/electron/src/admin-desktop.ts)
- [Freedesktop Exec quoting](https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html)
