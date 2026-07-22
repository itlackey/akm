// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { registerSourceProvider } from "../provider-factory";
import {
  ensureWebsiteMirror,
  getWebsiteCachePaths,
  shouldAllowPrivateWebsiteUrlForTests,
  validateWebsiteUrl,
} from "../snapshot-fetchers/website-ingest";

/**
 * Website source provider — thin adapter over the shared website ingest module.
 */
registerSourceProvider("website", (config) => {
  const allowPrivateHosts = shouldAllowPrivateWebsiteUrlForTests(config.url ?? "");
  const url = validateWebsiteUrl(config.url ?? "", { allowPrivateHosts });
  const name = config.name ?? "website";
  return {
    kind: "website" as const,
    name,
    path() {
      return getWebsiteCachePaths(url).stashDir;
    },
    async sync(options?: { force?: boolean }) {
      await ensureWebsiteMirror(config, {
        requireStashDir: true,
        force: options?.force,
        ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
      });
    },
  };
});
