// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { resolveStashDir } from "../../core/common";
import { ConfigError } from "../../core/errors";
import { registerSourceProvider } from "../provider-factory";

/**
 * Filesystem source — points at a directory the user already manages.
 *
 * Implements the v1 {@link SourceProvider} interface (spec §2.1, §2.4):
 * just `{ name, kind, init, path }`. No `sync()` — content is the user's
 * own directory, never refreshed by akm.
 */
registerSourceProvider("filesystem", (entry) => {
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
    async init(_ctx) {},
    path() {
      return stashDir;
    },
  };
});
