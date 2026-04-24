## 5. Ollama not detected

**Symptoms:** Setup wizard or connection test reports "Ollama not available"
despite Ollama running on the host.

**Cause:** Containers cannot reach `localhost` on the host. Docker requires
the special hostname `host.docker.internal`.

**Solution:**

1. Verify Ollama is running on the host:
   ```bash
   curl http://localhost:11434/api/tags
   ```
2. Verify the container can reach it:
   ```bash
   docker exec openpalm-admin-1 curl http://host.docker.internal:11434/api/tags
   ```
3. Set the Ollama base URL to `http://host.docker.internal:11434` in the
   admin UI Connections page, or in `secrets.env`:
   ```env
   OPENAI_BASE_URL=http://host.docker.internal:11434/v1
   ```

The compose file includes `extra_hosts: host.docker.internal:host-gateway`
on relevant services.

---

## 6. Channel not connecting (HMAC errors)

**Symptoms:** Channel container logs show "401 Unauthorized" or "HMAC
verification failed" when sending messages to the guardian.

**Cause:** The channel's HMAC secret does not match what the guardian expects.
Secrets are auto-generated during channel install and stored in
`DATA_HOME/stack.env`.

**Solution:**

1. Verify the channel secret exists in `DATA_HOME/stack.env`:
   ```bash
   grep CHANNEL_ ~/.local/share/openpalm/stack.env
   ```
2. If missing, reinstall the channel via the admin API:
   ```bash
   curl -X POST http://localhost:8100/admin/channels/install \
     -H "x-admin-token: $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name": "chat"}'
   ```
3. After install, the admin runs an apply step that stages secrets to
   `STATE_HOME/artifacts/stack.env`. Verify the guardian can read the
   staged file:
   ```bash
   docker exec openpalm-guardian-1 cat /app/secrets/stack.env | grep CHANNEL_
   ```

---

## 7. Assistant not responding

**Symptoms:** Messages sent through a channel never receive a reply. The
guardian logs show the request was forwarded, but the assistant does not
respond.

**Cause:** The assistant container may be unhealthy, missing an LLM API key,
or unable to reach the configured provider.

**Solution:**

1. Check assistant health:
   ```bash
   docker inspect openpalm-assistant-1 --format '{{.State.Health.Status}}'
   ```
2. Check assistant logs:
   ```bash
   docker logs openpalm-assistant-1 --tail 50
   ```
3. Verify at least one LLM provider key is set in `CONFIG_HOME/secrets.env`:
   ```bash
   grep -E 'API_KEY|BASE_URL' ~/.config/openpalm/secrets.env
   ```
4. If using Ollama, confirm the model is pulled:
   ```bash
   curl http://localhost:11434/api/tags
   ```

---

## 8. Permission denied errors

**Symptoms:** Containers fail to start with "permission denied" on volume
mounts, or files created by containers are owned by root and cannot be
edited.

**Cause:** UID/GID mismatch between the host user and the container user.
Containers run as `OPENPALM_UID:OPENPALM_GID` (default 1000:1000).

**Solution:**

1. Fix ownership of OpenPalm directories:
   ```bash
   sudo chown -R $(id -u):$(id -g) \
     ~/.config/openpalm \
     ~/.local/share/openpalm \
     ~/.local/state/openpalm
   ```
2. Verify UID/GID in `DATA_HOME/stack.env` matches your host user:
   ```bash
   grep OPENPALM_UID ~/.local/share/openpalm/stack.env
   id -u
   ```
3. After fixing ownership, recreate containers (do NOT use `docker restart`
   -- it does not re-read env_file changes):
   ```bash
   docker compose up -d --force-recreate
   ```

---