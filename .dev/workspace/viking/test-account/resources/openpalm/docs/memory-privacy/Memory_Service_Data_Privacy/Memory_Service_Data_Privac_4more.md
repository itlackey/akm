# Memory Service Data Privacy

This document describes what the OpenPalm memory service stores, where it stores it, what external calls it makes, and how to manage or delete memory data.

## What is stored

The memory service stores **extracted facts**, not raw conversation transcripts. When the assistant sends a conversation to the memory service, an LLM extracts discrete factual statements (e.g., "User prefers TypeScript over JavaScript") and stores each one individually.

Each memory record in the SQLite database contains:

| Column | Description |
|---|---|
| `id` | UUID v4 identifier |
| `data` | The extracted fact text (a plain-language statement) |
| `hash` | MD5 hash of the fact text (used for change detection) |
| `user_id` | User identifier (e.g., `default_user`) |
| `agent_id` | Agent identifier (if provided) |
| `run_id` | Run/session identifier (if provided) |
| `metadata` | JSON object with optional fields: `category`, `source`, `confidence`, `access_count`, `last_accessed`, feedback scores |
| `created_at` | Timestamp of creation |
| `updated_at` | Timestamp of last modification |

In addition to the metadata table, a **vector embedding** of each fact is stored in a `sqlite-vec` virtual table. This is a float array (dimensions depend on the configured embedding model) used for semantic similarity search.

A **history table** tracks all mutations (ADD, UPDATE, DELETE) to memory records, storing the previous and new values along with timestamps. This provides an audit trail of how memories change over time.

## Where it is stored

All memory data lives in a single SQLite database file on the local filesystem:

- **Default path (production):** `~/.local/share/openpalm/memory/memory.db`
- **Dev mode path:** `.dev/data/memory/memory.db`
- **Inside the container:** `/data/memory.db` (volume-mounted from the host path above)

Associated WAL and SHM files (`memory.db-wal`, `memory.db-shm`) may also exist alongside the database.

The memory configuration file is stored at:
- `~/.local/share/openpalm/memory/default_config.json` (or `.dev/data/memory/default_config.json` in dev mode)

**No data is synced to any cloud service.** The SQLite database and all memory data remain entirely on the host machine.

## What is NOT stored

- **API keys or tokens.** API keys for LLM/embedding providers are stored in `secrets.env` (in CONFIG_HOME), not in the memory database. The memory service resolves `env:VAR_NAME` references at runtime.
- **Passwords or credentials.**
- **Raw conversation transcripts.** The memory service receives conversation text only to extract facts from it. The raw conversation text is not persisted; only the LLM-extracted facts are stored.
- **Embedding model weights or binaries.** Only the computed vector embeddings are stored.