---
description: Order of the label sync job.
updated: 2026-07-02
---

The label sync job must run after `catalog-import` and before `search-reindex`, otherwise new labels are missing from search for a day. It reads `LABEL_SYNC_BATCH` (default 500) and logs skipped rows to `logs/label-sync.skipped`.
