# Fresh-Host Rebuild Runbook

Rebuild a working akm install on a new machine. Assumes your stash lives in a
git remote and that a versioned `config.json` copy is committed to the stash
git (the 08-F1 recovery pattern — see step 3).

1. **Install the CLI.** Prebuilt binary (no runtime needed):
   `curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash`
   — or npm package (Node.js >= 22 required): `npm install -g akm-cli`.
   If a working Bun >= 1.0 is also on `PATH`, the package prefers it after Node
   bootstrap; old, unusable, or absent Bun installations fall back to Node.js.
   The standalone binary is runtime-free.
   (Windows: `irm https://github.com/itlackey/akm/releases/latest/download/install.ps1 | iex`.)
2. **Confirm the binary resolves:** `akm --version`.
3. **Restore `config.json`.** akm reads a single user config at
   `~/.config/akm/config.json` (`%APPDATA%\akm\config.json` on Windows;
   override with `AKM_CONFIG_DIR`). This file is gitignored on the host, so the
   recovery source is the ONE versioned copy committed to the stash git
   (08-F1 pattern). Copy that file into place; it carries named `engines`,
   `defaults.engine` / `defaults.llmEngine`, and cron-load-bearing improve
   strategies that are otherwise unrecoverable.
4. **Provide secrets/env.** `config.json` references API keys via `${VAR}`
   placeholders; export those environment variables (or restore your env/secret
   assets) so named engines and the embedding connection resolve. Never commit
   the resolved values.
5. **Restore the working stash.** Clone your stash git remote to the `stashDir`
   named in the restored config (default `~/akm`). If starting clean instead,
   run `akm setup --yes` to scaffold it.
6. **Re-add non-git sources.** For each managed source not carried in the stash
   git (websites, npm packages, GitHub repos), run `akm add <ref>`. Verify the
   full set with `akm list`.
7. **Rebuild the index:** `akm index --full` (forces a complete reindex rather
   than an incremental update).
8. **Verify health:** `akm health` (checks runtime, artifacts, and improve
   metrics — exits non-zero if `state.db` is missing) and `akm info` for index
   stats and effective config.
9. **Smoke-test discovery:** `akm search <term>` returns results, confirming the
   index and stash are wired correctly.
