## 4. Create secrets.env

This file holds your admin token and LLM provider keys. Copy the template from `assets/secrets.env` and fill in the values:

```bash
cp assets/secrets.env ~/.config/openpalm/secrets.env
```

Or create it manually:

```bash
cat > ~/.config/openpalm/secrets.env << 'EOF'
# Required — change this before exposing the stack
ADMIN_TOKEN=change-me-to-a-strong-token

# At least one LLM key recommended
OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GROQ_API_KEY=
# MISTRAL_API_KEY=
# GOOGLE_API_KEY=

MEMORY_USER_ID=default_user
EOF
```

Set `ADMIN_TOKEN` to a strong random value:

```bash
# Generate a token and write it in place
TOKEN=$(openssl rand -hex 24)
sed -i "s/ADMIN_TOKEN=.*/ADMIN_TOKEN=$TOKEN/" ~/.config/openpalm/secrets.env
echo "Your admin token: $TOKEN"
```

Stage it to STATE_HOME for compose:

```bash
cp ~/.config/openpalm/secrets.env ~/.local/state/openpalm/artifacts/secrets.env
```

---

## 5. Create stack.env

`stack.env` holds system-managed infrastructure config. The admin regenerates this on every apply, but it must exist before the first start.

```bash
cat > ~/.local/share/openpalm/stack.env << EOF
# OpenPalm Stack Configuration — system-managed
# Overwritten by admin on each apply.

# ── XDG Paths ──────────────────────────────────────────────────────
OPENPALM_CONFIG_HOME=$HOME/.config/openpalm
OPENPALM_DATA_HOME=$HOME/.local/share/openpalm
OPENPALM_STATE_HOME=$HOME/.local/state/openpalm
OPENPALM_WORK_DIR=$HOME/openpalm

# ── User/Group ──────────────────────────────────────────────────────
OPENPALM_UID=$(id -u)
OPENPALM_GID=$(id -g)

# ── Docker Socket ───────────────────────────────────────────────────
OPENPALM_DOCKER_SOCK=/var/run/docker.sock

# ── Images ──────────────────────────────────────────────────────────
OPENPALM_IMAGE_NAMESPACE=openpalm
OPENPALM_IMAGE_TAG=latest

# ── Networking ──────────────────────────────────────────────────────
OPENPALM_INGRESS_BIND_ADDRESS=127.0.0.1
OPENPALM_INGRESS_PORT=8080

# ── Memory ──────────────────────────────────────────────────────
MEMORY_DASHBOARD_API_URL=http://localhost:8765
MEMORY_USER_ID=default_user

EOF
```

**Docker socket detection:** If you use OrbStack, Colima, or Rancher Desktop, the socket may not be at `/var/run/docker.sock`. Detect it with:

```bash
docker context inspect --format '{{.Endpoints.docker.Host}}'
# Example output: unix:///Users/you/.colima/default/docker.sock
```

Set `OPENPALM_DOCKER_SOCK` to the path after `unix://`.

Stage it to STATE_HOME:

```bash
cp ~/.local/share/openpalm/stack.env ~/.local/state/openpalm/artifacts/stack.env
```

---

## 6. Seed Memory config (optional)

Memory needs a default config file if you want memory features:

```bash
cat > ~/.local/share/openpalm/memory/default_config.json << 'EOF'
{
  "mem0": {
    "llm": {
      "provider": "openai",
      "config": {
        "model": "gpt-4o-mini",
        "temperature": 0.1,
        "max_tokens": 2000,
        "api_key": "env:OPENAI_API_KEY"
      }
    },
    "embedder": {
      "provider": "openai",
      "config": {
        "model": "text-embedding-3-small",
        "api_key": "env:OPENAI_API_KEY"
      }
    },
    "vector_store": {
      "provider": "qdrant",
      "config": {
        "collection_name": "memory",
        "path": "/data/qdrant",
        "embedding_model_dims": 1536
      }
    }
  },
  "memory": {
    "custom_instructions": ""
  }
}
EOF
```

---

## 7. Set file ownership

Ensure your user owns everything:

```bash
chown -R "$(id -u):$(id -g)" \
  ~/.config/openpalm \
  ~/.local/share/openpalm \
  ~/.local/state/openpalm \
  ~/openpalm
```

---