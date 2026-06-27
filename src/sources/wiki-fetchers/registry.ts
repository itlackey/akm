// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { warn } from "../../core/warn";
import youtubeFetcher from "./youtube";

export interface WikiSnapshotResult {
  url: string;
  title: string;
  markdown: string;
  preferredName?: string;
  tags?: string[];
}

export interface FetcherContext {
  stashDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface WikiSnapshotFetcher {
  name: string;
  matches(url: URL, context: FetcherContext): boolean;
  fetch(url: URL, context: FetcherContext): Promise<WikiSnapshotResult | null>;
}

const FETCHER_DIR = path.join("scripts", "wiki-fetchers");
const FETCHER_FILE_PATTERN = /\.(?:ts|js|mjs)$/i;
const BUILTIN_FETCHERS: readonly WikiSnapshotFetcher[] = [youtubeFetcher];

function isWikiSnapshotFetcher(value: unknown): value is WikiSnapshotFetcher {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WikiSnapshotFetcher>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.matches === "function" &&
    typeof candidate.fetch === "function"
  );
}

export async function loadWikiSnapshotFetchers(stashDir?: string | null): Promise<WikiSnapshotFetcher[]> {
  const fetchers: WikiSnapshotFetcher[] = [];

  if (stashDir) {
    const fetcherDir = path.join(stashDir, FETCHER_DIR);
    try {
      const entries = fs.readdirSync(fetcherDir).sort();
      for (const entry of entries) {
        if (!FETCHER_FILE_PATTERN.test(entry)) continue;

        try {
          const fileUrl = pathToFileURL(path.join(fetcherDir, entry)).toString();
          const mod = await import(fileUrl);
          if (isWikiSnapshotFetcher(mod.default)) {
            fetchers.push(mod.default);
          } else {
            warn("[akm] wiki-fetcher %s skipped: missing { name, matches, fetch }", entry);
          }
        } catch (error) {
          warn(
            "[akm] wiki-fetcher %s failed to load: %s",
            entry,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") {
        warn(
          "[akm] wiki-fetcher directory %s could not be read: %s",
          fetcherDir,
          error instanceof Error ? error.message : String(error),
        );
      }
      // Missing directory means no custom fetchers.
    }
  }

  return [...fetchers, ...BUILTIN_FETCHERS];
}
