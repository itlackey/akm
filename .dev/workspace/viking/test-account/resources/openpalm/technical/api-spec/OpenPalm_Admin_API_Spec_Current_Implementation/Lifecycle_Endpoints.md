## Lifecycle Endpoints

Policy for this section:

- `CONFIG_HOME` is the user-owned persistent source of truth.
- `POST /admin/install`, `POST /admin/update`, and startup auto-apply are
  automatic lifecycle operations: non-destructive for existing user config files
  in `CONFIG_HOME`; they only seed missing defaults and restage runtime
  artifacts in `STATE_HOME`.
- Explicit mutation endpoints (`POST /admin/connections`,
  `POST /admin/channels/install`, `POST /admin/channels/uninstall`,
  `POST /admin/access-scope`, `POST /admin/setup`) are the allowed write path
  for requested config changes.

### `POST /admin/install`

- Ensures XDG directories + OpenCode starter config + starter user secrets.
- Seeds only missing defaults in `CONFIG_HOME`; never overwrites existing user files.
- Stages artifacts into `STATE_HOME`.
- Runs `docker compose up -d` using staged compose files and staged env file.

Response:

```json
{
  "ok": true,
  "started": ["caddy", "memory", "assistant", "guardian", "admin", "channel-chat"],
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" },
  "artifactsDir": "/home/user/.local/state/openpalm/artifacts"
}
```

### `POST /admin/update`

- Non-destructive for existing `CONFIG_HOME` user config; seeds missing defaults only.
- Re-stages artifacts.
- Re-applies compose with staged overlays.

Response:

```json
{ "ok": true, "restarted": ["caddy", "guardian"], "dockerAvailable": true }
```

### `POST /admin/uninstall`

- Runs compose down.
- Does not delete or rewrite existing user config in `CONFIG_HOME`.
- Marks in-memory services stopped and re-stages artifacts.

Response:

```json
{ "ok": true, "stopped": ["caddy", "assistant"], "dockerAvailable": true }
```

### `POST /admin/upgrade`

Full upgrade sequence: fetches the latest image tag, downloads fresh core assets
from GitHub, backs up changed files, stages artifacts, pulls images, and
recreates all containers. After responding, schedules a deferred self-recreation
of the admin container so the HTTP response is flushed first.

Response:

```json
{
  "ok": true,
  "imageTag": "0.9.0",
  "backupDir": "/home/user/.local/state/openpalm/backups/2025-01-01T00-00-00",
  "assetsUpdated": ["docker-compose.yml", "Caddyfile"],
  "restarted": ["caddy", "guardian"],
  "adminRecreateScheduled": true
}
```

Error responses:

- `502 image_tag_update_failed` — Failed to resolve latest image tag.
- `502 asset_download_failed` — Failed to download fresh assets from GitHub.
- `503 docker_unavailable` — Docker is not reachable.
- `502 pull_failed` — `docker compose pull` failed.
- `502 up_failed` — Images pulled but container recreation failed.