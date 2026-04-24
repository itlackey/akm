## Common Tasks

**Change an LLM API key:**
1. Edit `~/.config/openpalm/secrets.env`
2. Restart admin: `docker compose restart admin`

**Add a new LLM provider:**
1. Add the API key to `secrets.env`
2. Edit `~/.config/openpalm/assistant/opencode.json` to configure the provider
3. Restart assistant: `docker compose restart assistant`

**Rotate the admin token:**
1. Update `ADMIN_TOKEN` in `secrets.env`
2. Restart all services: `docker compose restart`

**Add an automation:**
1. Create `~/.config/openpalm/automations/my-job` with your schedule
2. Restart admin: `docker compose restart admin`

**View audit logs:**
```bash
tail -f ~/.local/state/openpalm/audit/admin-audit.jsonl
tail -f ~/.local/state/openpalm/audit/guardian-audit.log
```

**Check container status:**
```bash
docker compose ps
# Or via API:
curl http://localhost:8100/admin/containers/list \
  -H "x-admin-token: $ADMIN_TOKEN"
```

**Pull latest images and recreate containers:**
```bash
curl -X POST http://localhost:8100/admin/containers/pull \
  -H "x-admin-token: $ADMIN_TOKEN"
```

This runs `docker compose pull` followed by `docker compose up` to recreate
containers with the updated images. Equivalent to a manual
`docker compose pull && docker compose up -d`.

**Docker socket GID** is auto-detected from `/var/run/docker.sock` by the admin at startup
and written to `STATE_HOME/artifacts/stack.env`. You do not need to set it manually.
If the admin fails to reach Docker, check that the socket exists and is readable.