## Working Directory

The assistant container mounts `$OPENPALM_WORK_DIR` (default: `$HOME/openpalm`)
at `/work` and sets it as the working directory. This is where the assistant
operates on user projects and scripts.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENPALM_WORK_DIR` | `$HOME/openpalm` | Host directory mounted at `/work` in the assistant |