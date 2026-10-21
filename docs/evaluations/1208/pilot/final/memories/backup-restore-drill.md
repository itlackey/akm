---
description: Result of the backup restore drill.
updated: 2026-07-15
---

The 2026-07-14 restore drill took 47 minutes for the 120 GB `orders` database from the nightly snapshot. The slow step was replaying WAL segments; keeping only 24 hours of segments in `s3://backups-orders/wal/` cut the replay to 9 minutes.
