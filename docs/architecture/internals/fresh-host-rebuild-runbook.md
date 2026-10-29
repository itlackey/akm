# Fresh-Host Rebuild Runbook

Rebuild a working akm install on a new machine. It assumes your bundle lives in
a git remote and that you kept a copy of `config.json` somewhere you can
restore it from.

1. **Install the CLI.** Prebuilt binary (no runtime needed):
   `curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash`
   (Windows: `irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex`).
   Or the npm package, which needs Node.js 22 or later: `npm install -g akm-cli`.
   A working Bun 1.0 or later on `PATH` is optional and preferred over Node.
2. **Confirm the binary resolves:** `akm --version`.
3. **Restore `config.json`.** akm reads one user config at
   `~/.config/akm/config.json` (`%APPDATA%\akm\config.json` on Windows; set
   `AKM_CONFIG_DIR` to move it). It holds your `connections`, `harnesses`, and
   your improve strategies.
4. **Provide secrets.** `config.json` refers to API keys as `$VAR` or
   `${VAR}`. Export those environment variables, or restore `credentials.json`
   from your own backup (it is never part of `config.json`), so the
   connections and the embedding endpoint resolve.
5. **Restore the working bundle.** Clone your bundle's git remote to the path
   of the working bundle's entry under `bundles` in the restored config
   (`defaultBundle` selects which one; the default path is `~/akm`). To start
   clean instead, run `akm setup --yes`, which scaffolds the bundle.
6. **Check the other bundles.** `akm bundle list` shows the bundles the
   restored config defines. Re-add any that are missing with
   `akm bundle add <ref>`.
7. **Rebuild the index:** `akm index --full`. `index.db` is derived from your
   bundles and is rebuilt from scratch.
8. **Verify health:** `akm health`, then `akm info` for index stats and the
   effective config. `akm health` creates `state.db` if it is missing and
   applies its migrations. It exits 0 when every check passes, 4 on warnings,
   and 1 when a hard check fails. See [Health Checks](health-advisories.md) for
   what each check means.
9. **Smoke-test discovery:** `akm search <term>` returns results.

`$DATA/state.db` holds proposals, events, and task history, and is not rebuilt
from your bundles. Copy it from the old host before step 8 if you want that
history.
