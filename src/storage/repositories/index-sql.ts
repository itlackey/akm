// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared SQL constants for the `index.db` storage repositories.
 */

/**
 * SQLite parameter chunk size — chosen well below SQLITE_MAX_VARIABLE_NUMBER
 * (default 999 on most builds) so multi-row `IN (?, ?, ...)` queries stay
 * within bounds. Shared by the entries / fts / utility / llm-cache repos.
 */
export const SQLITE_CHUNK_SIZE = 500;
