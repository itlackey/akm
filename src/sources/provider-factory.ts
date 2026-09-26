// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source provider factories for the four supported source kinds
 * (`filesystem`, `git`, `website`, `npm`).
 */

import type { SourceProviderFactory } from "./provider";
import { createFilesystemProvider } from "./providers/filesystem";
import { GitSourceProvider } from "./providers/git-provider";
import { NpmSourceProvider } from "./providers/npm";
import { createWebsiteProvider } from "./providers/website";

/** The factory for a configured source kind, or null for a kind akm does not support. */
export function resolveSourceProviderFactory(type: string): SourceProviderFactory | null {
  switch (type) {
    case "filesystem":
      return createFilesystemProvider;
    case "git":
      return (config) => new GitSourceProvider(config);
    case "npm":
      return (config) => new NpmSourceProvider(config);
    case "website":
      return createWebsiteProvider;
    default:
      return null;
  }
}
