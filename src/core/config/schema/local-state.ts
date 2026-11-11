// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `usage` and `storage` config sections: how akm treats its own local data.
 * Both are read before the config load, from the file itself (see `./peek.ts`).
 */
import { z } from "zod";

/** `usage.capture`: record local-only CLI usage counts in `usage.sqlite`. Default `true`. */
export const UsageConfigSchema = z
  .object({
    capture: z.boolean().optional(),
  })
  .passthrough();

/**
 * `storage.journalMode`: the SQLite journal mode, `WAL` (default), `DELETE` or
 * `TRUNCATE`. The `AKM_SQLITE_JOURNAL_MODE` environment variable wins over it.
 * An unrecognised value warns once and falls back to WAL, so it is a plain string here.
 */
export const StorageConfigSchema = z
  .object({
    journalMode: z.string().optional(),
  })
  .passthrough();
