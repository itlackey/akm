// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { resolveStashDir } from "../../core/common";
import type { SourceConfigEntry } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import type { SourceProvider } from "../provider";

/**
 * Filesystem source — points at a directory the user already manages.
 *
 * Implements {@link SourceProvider} with `{ name, kind, path }`. No `sync()`:
 * content is the user's own directory, never refreshed by akm.
 */
export function createFilesystemProvider(entry: SourceConfigEntry): SourceProvider {
  if (entry.type !== "filesystem") {
    throw new ConfigError(`filesystem source invoked with type="${entry.type}"`);
  }
  const stashDir = entry.path ?? resolveStashDir();
  if (!stashDir) {
    throw new ConfigError("filesystem source requires a `path`");
  }
  const name = entry.name ?? stashDir;
  return {
    kind: "filesystem" as const,
    name,
    path() {
      return stashDir;
    },
  };
}
