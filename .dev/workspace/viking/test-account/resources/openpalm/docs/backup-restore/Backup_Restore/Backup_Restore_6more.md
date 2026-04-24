# Backup & Restore

OpenPalm stores all persistent data on the host filesystem using the XDG
three-tier directory model. This makes backup and restore straightforward:
archive the right directories, restore them, and restart the stack.

---

## What to back up

| Directory | Default path | Contains | Back up? |
|-----------|-------------|----------|----------|
| **CONFIG_HOME** | `~/.config/openpalm` | secrets.env, channels, automations, assistant extensions | Yes |
| **DATA_HOME** | `~/.local/share/openpalm` | stack.env, memory (SQLite), assistant config, guardian data, Caddy certs | Yes |
| **STATE_HOME** | `~/.local/state/openpalm` | Staged artifacts, audit logs | No -- regenerated on next apply |

STATE_HOME is assembled from CONFIG_HOME and DATA_HOME by the admin on every
startup. It does not need to be backed up. Audit logs in
`STATE_HOME/audit/` are the one exception -- archive those separately if
you need an audit trail.

---

## Stop the stack before backup

SQLite databases (memory service) can produce corrupt backups if written to
during archiving. Stop the stack first for a consistent snapshot:

```bash
docker compose down
```

If downtime is not acceptable, the memory SQLite database supports WAL mode
and a hot backup is unlikely to corrupt, but stopping is the only guarantee.

---

## Backup

Archive CONFIG_HOME and DATA_HOME into a single tarball:

```bash
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz \
  ~/.config/openpalm \
  ~/.local/share/openpalm
```

For custom XDG paths, substitute the actual directories:

```bash
tar czf openpalm-backup-$(date +%Y%m%d).tar.gz \
  "$OPENPALM_CONFIG_HOME" \
  "$OPENPALM_DATA_HOME"
```

Restart the stack after backup:

```bash
docker compose up -d
```

---

## Restore

### 1. Stop the stack

```bash
docker compose down
```

### 2. Extract the backup

```bash
tar xzf openpalm-backup-YYYYMMDD.tar.gz -C /
```

This restores files to their original absolute paths. If restoring to a
different user or machine, extract to a staging directory first and move
files to the correct locations.

### 3. Fix ownership

Container processes run as `OPENPALM_UID:OPENPALM_GID` (default 1000:1000).
After restoring from a backup taken on a different machine or by a different
user, fix file ownership:

```bash
sudo chown -R $(id -u):$(id -g) \
  ~/.config/openpalm \
  ~/.local/share/openpalm \
  ~/.local/state/openpalm
```

### 4. Restart the stack

The admin's startup apply regenerates STATE_HOME from the restored
CONFIG_HOME and DATA_HOME:

```bash
docker compose up -d
```

Run `docker compose` from the directory containing the compose file, or
pass `-f` with the path to `STATE_HOME/artifacts/docker-compose.yml`.

---

## Migration to a new machine

1. On the old machine, stop the stack and create a backup (see above).
2. Transfer the tarball to the new machine.
3. Install Docker on the new machine.
4. Download the installer without starting the stack:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/v0.9.0-rc5/scripts/setup.sh \
     -o setup.sh
   bash setup.sh --no-start
   ```

   Do not pipe directly to `bash` if you need to pass `--no-start`.

5. Extract the backup over the freshly seeded directories:

   ```bash
   tar xzf openpalm-backup-YYYYMMDD.tar.gz -C /
   ```

6. Fix ownership (see step 3 above).
7. Start the stack:

   ```bash
   docker compose up -d
   ```

The admin will detect the existing configuration and skip the setup wizard.

---