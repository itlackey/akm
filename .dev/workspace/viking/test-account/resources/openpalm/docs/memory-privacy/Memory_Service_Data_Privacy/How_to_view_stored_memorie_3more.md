## How to view stored memories

### Admin API

List memories for a user (requires admin token):

```bash
# List all memories
curl -X POST http://localhost:8100/admin/memory/filter \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "default_user"}'
```

### Memory service API (direct)

The memory service exposes a REST API on port 8765 (accessible from within the Docker network, and optionally bound to the host):

```bash
# List memories via filter endpoint
curl -X POST http://localhost:8765/api/v1/memories/filter \
  -H "Content-Type: application/json" \
  -d '{"user_id": "default_user", "size": 50}'

# Search memories semantically
curl -X POST http://localhost:8765/api/v2/memories/search \
  -H "Content-Type: application/json" \
  -d '{"user_id": "default_user", "query": "programming preferences"}'

# Get a specific memory by ID
curl http://localhost:8765/api/v1/memories/MEMORY_UUID

# Get memory stats
curl "http://localhost:8765/api/v1/stats/?user_id=default_user"

# View current config (API keys are redacted)
curl http://localhost:8765/api/v1/config/
```

### Assistant tools

The assistant can list and search memories through its built-in tools: `memory-list`, `memory-search`, `memory-get`, and `memory-stats`.

## How to wipe all memory data

### Option 1: Delete the SQLite database file

Stop the memory container, then delete the database file and its WAL/SHM companions:

```bash
# Stop the memory service
docker compose stop memory

# Remove the database (adjust path for your DATA_HOME)
rm -f ~/.local/share/openpalm/memory/memory.db
rm -f ~/.local/share/openpalm/memory/memory.db-wal
rm -f ~/.local/share/openpalm/memory/memory.db-shm

# Restart — a fresh empty database will be created automatically
docker compose start memory
```

### Option 2: Admin API reset endpoint

The admin API provides a reset endpoint that deletes the SQLite database file and any legacy Qdrant data. The memory container must be restarted afterwards:

```bash
curl -X POST http://localhost:8100/admin/memory/reset-collection \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"

# Then restart the memory container to recreate empty tables
docker compose restart memory
```

### Option 3: Delete individual memories or all memories for a user

```bash
# Delete a single memory
curl -X DELETE http://localhost:8765/api/v1/memories/ \
  -H "Content-Type: application/json" \
  -d '{"memory_id": "MEMORY_UUID"}'

# Delete all memories for a user
curl -X DELETE http://localhost:8765/api/v1/memories/ \
  -H "Content-Type: application/json" \
  -d '{"user_id": "default_user"}'
```

### Option 4: Assistant tools

The assistant has a `memory-delete` tool that can remove individual memories by ID.

## Data retention

- **No automatic expiry.** Memories persist indefinitely until explicitly deleted.
- **No automatic cleanup.** The memory service does not prune old or low-confidence memories on its own.
- **User controls all data.** The operator has full control over when memories are created, updated, and deleted. The SQLite database is a regular file on disk that can be backed up, inspected, or removed at any time.
- **History is retained alongside memories.** The mutation history table records all ADD, UPDATE, and DELETE operations. Resetting the collection (Option 2 above) or deleting the database file (Option 1) also removes all history records.