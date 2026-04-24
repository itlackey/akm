# Troubleshooting

Common problems and their solutions. For setup-specific issues, see
also the troubleshooting section of [setup-guide.md](setup-guide.md).

---

## 1. Docker not found

**Symptoms:** Installer exits with "docker: command not found" or
"Cannot connect to the Docker daemon."

**Cause:** Docker Engine (Linux) or Docker Desktop (Mac/Windows) is not
installed or not running.

**Solution:**

```bash
# Verify Docker is running
docker info

# Linux: install Docker Engine
curl -fsSL https://get.docker.com | sh

# Linux: fix permission denied
sudo usermod -aG docker $USER
# Log out and back in for group change to take effect
```

On Mac/Windows, open Docker Desktop and wait for the green "Running" indicator
before retrying.

---

## 2. Port conflicts

**Symptoms:** Container exits immediately or `docker compose up` reports
"address already in use." Common ports: 8080 (Caddy ingress), 8100 (admin),
8765 (memory), 4096 (assistant).

**Cause:** Another process is already bound to the port.

**Solution:**

```bash
# Find what is using the port (example: 8080)
lsof -i :8080
# or
ss -tlnp | grep 8080
```

Either stop the conflicting process, or change the OpenPalm bind port by
editing `DATA_HOME/stack.env`:

```env
OPENPALM_INGRESS_PORT=9090
```

Then restart the stack:

```bash
docker compose down && docker compose up -d
```

The default Caddy ingress port is `8080` (see `OPENPALM_INGRESS_PORT` in
`docker-compose.yml`).

---

## 3. Setup wizard won't load

**Symptoms:** Browser shows connection refused or a blank page at
`http://localhost:8080/` after install.

**Cause:** The admin container is still starting (pulling images on first
boot can take several minutes) or the admin healthcheck hasn't passed yet.

**Solution:**

1. Check admin container status:
   ```bash
   docker logs openpalm-admin-1 --tail 50
   ```
2. If the admin is healthy but Caddy isn't routing, access the admin directly
   at `http://localhost:8100/setup`.
3. Wait up to 60 seconds on first boot for image pulls and healthcheck
   stabilization.

---

## 4. Memory service failures

**Symptoms:** Memory API returns 500 errors, assistant reports "memory
unavailable," or the memory container restart-loops.

**Cause:** Usually one of: sqlite-vec native module load failure, incorrect
Ollama URL, or embedding dimension mismatch.

**Solution:**

Check memory container logs:

```bash
docker logs openpalm-memory-1 --tail 50
```

Common fixes:

- **sqlite-vec load error:** The memory image requires glibc (it uses
  `oven/bun:1-debian`, not Alpine). If you are building locally, verify the
  base image.

- **Ollama URL:** When Ollama runs on the host (not in Docker), containers
  must reach it at `http://host.docker.internal:11434`, not `localhost`. Set
  this in `DATA_HOME/memory/default_config.json`:
  ```json
  {
    "llm": { "config": { "ollama_base_url": "http://host.docker.internal:11434" } },
    "embedder": { "config": { "ollama_base_url": "http://host.docker.internal:11434" } }
  }
  ```

- **Embedding dimension mismatch:** The configured `embedding_model_dims`
  must match the model. `nomic-embed-text` uses 768 dimensions. Mismatched
  dims cause silent vector storage failures.

---