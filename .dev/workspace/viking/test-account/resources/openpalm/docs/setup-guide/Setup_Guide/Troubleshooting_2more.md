## Troubleshooting

### Docker not found

The installer requires Docker Engine (Linux) or Docker Desktop (Mac). Verify it's running:

```bash
docker info
```

If you see a permission error on Linux, add your user to the `docker` group:

```bash
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

### Admin won't start

Check if the port is already in use:

```bash
lsof -i :8100
```

Check admin container logs:

```bash
docker logs openpalm-admin-1
```

### Setup wizard doesn't open

Navigate manually to `http://localhost:8100/setup`. If the admin isn't healthy yet, wait a moment — it pulls images on first start which can take time on slow connections.

### Containers keep restarting

Check logs for the failing container:

```bash
docker compose logs <service-name>
```

Common causes:
- Missing API key in `secrets.env` (assistant needs at least one LLM provider key)
- Port conflict with another service on the host
- Insufficient disk space for container data

### Reset to fresh state

To start over completely:

```bash
# Stop everything
docker compose down -v

# Remove all OpenPalm data (DESTRUCTIVE — removes your config, data, and state)
rm -rf ~/.config/openpalm ~/.local/share/openpalm ~/.local/state/openpalm

# Re-run the installer
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

```powershell
# Stop everything
docker compose down -v

# Remove all OpenPalm data (DESTRUCTIVE — removes your config, data, and state)
Remove-Item -Recurse -Force "$env:USERPROFILE\.config\openpalm", "$env:USERPROFILE\.local\share\openpalm", "$env:USERPROFILE\.local\state\openpalm"

# Re-run the installer
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

---

## Next Steps

| Guide | What's inside |
|---|---|
| [Setup Walkthrough](setup-walkthrough.md) | Detailed screen-by-screen walkthrough of the setup wizard |
| [Managing OpenPalm](managing-openpalm.md) | Day-to-day administration: secrets, channels, access control, extensions |
| [How It Works](how-it-works.md) | Architecture overview and data flow |
| [Directory Structure](technical/directory-structure.md) | Host paths, XDG tiers, volume mounts |
| [Community Channels](community-channels.md) | Building custom channel adapters |
| [Core Principles](technical/core-principles.md) | Security invariants and architectural rules |
| [API Spec](technical/api-spec.md) | Admin API endpoint reference |