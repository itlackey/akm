# System Requirements

Hardware, software, and network requirements for running OpenPalm.

---

## Software Prerequisites

| Requirement | Minimum Version | Notes |
|---|---|---|
| Docker Engine or Docker Desktop | 24.0+ | Must include Compose V2 (`docker compose`) |
| Docker Compose | V2 (2.20+) | Bundled with Docker Desktop and modern Docker Engine |
| curl | any | Used by the installer script |
| openssl | any | Used by the installer to generate admin tokens |

### Supported Operating Systems

| OS | Runtime | Notes |
|---|---|---|
| **Linux** (x86_64, arm64) | Docker Engine | Recommended. Native performance, no VM overhead |
| **macOS** (Apple Silicon or Intel) | Docker Desktop or OrbStack | OrbStack offers lower resource overhead |
| **Windows** (x86_64) | Docker Desktop with WSL2 | WSL2 backend required; Hyper-V backend is not supported |

---

## Hardware Requirements

### Minimum (core stack only, no channels)

The core stack runs 6 containers: caddy, memory, assistant, guardian, docker-socket-proxy, and admin.

| Resource | Minimum |
|---|---|
| CPU | 2 cores |
| RAM | 4 GB |
| Disk | 5 GB free (Docker images + runtime data) |

This assumes you are using a **remote LLM provider** (OpenAI, Anthropic, etc.) and not running local models.

### Recommended (core + 1-2 channels + Ollama)

Running local models via Ollama significantly increases resource needs because models must be loaded into RAM (or VRAM).

| Resource | Recommended |
|---|---|
| CPU | 4+ cores |
| RAM | 16 GB (8 GB for stack + 8 GB for Ollama models) |
| Disk | 20 GB+ free (images + model weights) |
| GPU | Optional but beneficial — any CUDA-capable NVIDIA GPU or Apple Silicon with Metal |

For larger models (13B+ parameters), 32 GB RAM or a GPU with 8+ GB VRAM is recommended.

---

## Per-Service Resource Profile

The core compose file (`assets/docker-compose.yml`) does not currently define `deploy.resources.limits`, so containers are unconstrained by default. The table below shows typical observed usage under light workloads.

| Service | Base Image | Runtime | Typical Idle RAM | Typical Active RAM | Purpose |
|---|---|---|---|---|---|
| **caddy** | `caddy:2-alpine` | Go binary | ~15 MB | ~30 MB | Reverse proxy, TLS termination |
| **memory** | `oven/bun:1-debian` | Bun + sqlite-vec | ~60 MB | ~150 MB | Vector memory store (embeddings + search) |
| **assistant** | `node:lts-trixie` | Node.js + OpenCode + Bun | ~200 MB | ~500 MB | AI runtime, tool execution, SSH server |
| **guardian** | `oven/bun:1.3-slim` | Bun | ~30 MB | ~60 MB | HMAC verification, rate limiting |
| **docker-socket-proxy** | `tecnativa/docker-socket-proxy` | HAProxy | ~10 MB | ~15 MB | Filtered Docker API proxy |
| **admin** | `node:lts-trixie-slim` | Node.js (SvelteKit) + Bun | ~80 MB | ~150 MB | Control plane, operator UI |
| **channel** (each) | `oven/bun:1.3-slim` | Bun | ~30 MB | ~60 MB | Protocol adapter (chat, API, Discord, etc.) |

**Total core stack (idle):** ~400 MB RAM
**Total core stack (active):** ~900 MB RAM
**Each added channel:** ~30-60 MB RAM

---