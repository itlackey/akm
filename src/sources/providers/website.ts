// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { registerSourceProvider } from "../provider-factory";
import { ensureWebsiteMirror, getWebsiteCachePaths, validateWebsiteUrl } from "../website-ingest";

/**
 * Website source provider — thin adapter over the shared website ingest module.
 */
registerSourceProvider("website", (config) => {
  const url = validateWebsiteUrl(config.url ?? "");
  const name = config.name ?? "website";
  return {
    kind: "website" as const,
    name,
    path() {
      return getWebsiteCachePaths(url).stashDir;
    },
    async sync() {
      await ensureWebsiteMirror(config, { requireStashDir: true });
    },
  };
});
