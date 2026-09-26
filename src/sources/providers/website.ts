// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SourceConfigEntry } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import type { SourceProvider, SyncOptions } from "../provider";
import { getWebsiteCachePaths, shouldAllowPrivateWebsiteUrlForTests, validateWebsiteUrl } from "../website-url";

export interface WebsiteSourceProvider extends SourceProvider {
  readonly kind: "website";
  sync(options?: SyncOptions): Promise<void>;
}

/** Website source provider — URL-derived path plus an injected mirror refresh. */
export function createWebsiteProvider(config: SourceConfigEntry): WebsiteSourceProvider {
  const allowPrivateHosts = shouldAllowPrivateWebsiteUrlForTests(config.url ?? "");
  const url = validateWebsiteUrl(config.url ?? "", { allowPrivateHosts });
  const name = config.name ?? "website";
  return {
    kind: "website" as const,
    name,
    path() {
      return getWebsiteCachePaths(url).rootDir;
    },
    async sync(options?: SyncOptions) {
      const ensureWebsiteMirror = options?.ensureWebsiteMirror;
      if (!ensureWebsiteMirror) {
        throw new ConfigError("Website provider sync requires an injected ensureWebsiteMirror capability");
      }
      await ensureWebsiteMirror(config, {
        requireStashDir: true,
        force: options?.force,
        // Feed the resolver into the injected mirror plumbing that
        // already threads `resolveSecret` down to `FetcherContext`. This is the
        // line that closes the bundle-update / sync() gap: previously the X
        // fetcher on this path saw only `X_BEARER_TOKEN`, never the store.
        ...(options?.secrets ? { resolveSecret: options.secrets.resolveSecret } : {}),
        ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
      });
    },
  };
}
