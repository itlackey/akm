## 9. Services won't start after update

**Symptoms:** After running the installer to update, containers fail to
start or enter a restart loop.

**Cause:** Stale staged artifacts in STATE_HOME, or a compose file version
mismatch between the new admin image and the old staged files.

**Solution:**

1. Check container logs for the specific error:
   ```bash
   docker compose logs --tail 20
   ```
2. Re-run the apply step by restarting the admin container (apply runs on
   startup):
   ```bash
   docker compose up -d --force-recreate admin
   ```
3. If the admin itself won't start, clear and re-stage artifacts manually:
   ```bash
   rm -rf ~/.local/state/openpalm/artifacts
   # Re-run the installer
   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.sh | bash
   ```
4. Pull the latest images explicitly:
   ```bash
   docker compose pull
   docker compose up -d
   ```

---

## 10. Factory reset

**Symptoms:** Nothing else works, or you want a clean slate.

**Cause:** Corrupted state, incompatible config from a previous version, or
experimental changes that need reverting.

**Solution:**

Stop and remove all containers and volumes, then delete all OpenPalm
directories:

```bash
# Stop the stack and remove volumes
docker compose down -v

# Remove all OpenPalm data (DESTRUCTIVE)
rm -rf ~/.config/openpalm ~/.local/share/openpalm ~/.local/state/openpalm

# Re-run the installer
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.sh | bash
```

On Windows (PowerShell):

```powershell
docker compose down -v
Remove-Item -Recurse -Force "$env:USERPROFILE\.config\openpalm", `
  "$env:USERPROFILE\.local\share\openpalm", `
  "$env:USERPROFILE\.local\state\openpalm"
irm https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.ps1 | iex
```

This removes all configuration, data, and state. Back up CONFIG_HOME and
DATA_HOME first if you have data worth preserving. See
[backup-restore.md](backup-restore.md) for backup procedures.