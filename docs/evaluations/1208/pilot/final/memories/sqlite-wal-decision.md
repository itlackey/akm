---
description: Decision to use SQLite WAL for agent state.
updated: 2026-05-03
---

On 2026-05-02 we chose SQLite WAL mode for the agent state store because concurrent readers blocked in rollback-journal mode. Run `PRAGMA journal_mode=WAL` when the connection opens, and keep the `-wal` file in the same directory as the database.
