// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Leaf URL and cache-path derivations shared by website source providers and
 * the website ingest pipeline.
 *
 * Keep this module independent of website-ingest and the snapshot-fetcher
 * registry. Provider registration must be safe to import from low-level source
 * resolution code without pulling the fetcher subgraph into that leaf.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { ConfigError, UsageError } from "../core/errors";
import { classifyNetworkHostname } from "../core/network-policy";
import { getRegistryIndexCacheDir } from "../core/paths";
import { warnOnce } from "../core/warn";
import { assertWebsiteRequestUrl, type HostnameResolver } from "./snapshot-fetchers/host-guard";

export interface WebsiteUrlValidationOptions {
  allowPrivateHosts?: boolean;
  /** Override DNS resolution for guarded tests. */
  resolveHostname?: HostnameResolver;
}

export interface WebsiteCachePaths {
  rootDir: string;
  stashDir: string;
  manifestPath: string;
}

export function shouldAllowPrivateWebsiteHostsForTests(): boolean {
  return process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
}

export function shouldAllowPrivateWebsiteUrlForTests(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (classifyNetworkHostname(hostname) === "public") return false;
  if (!shouldAllowPrivateWebsiteHostsForTests()) {
    warnOnce(
      `website-private-host:${hostname}`,
      `[akm] "${hostname}" is not a publicly routable host, but you added it as a source directly — proceeding. ` +
        "Links discovered elsewhere are still checked.",
    );
  }
  return true;
}

export function getWebsiteCachePaths(siteUrl: string): WebsiteCachePaths {
  const key = createHash("sha256").update(normalizeSiteUrl(siteUrl)).digest("hex").slice(0, 16);
  const rootDir = path.join(getRegistryIndexCacheDir(), `website-${key}`);
  return {
    rootDir,
    stashDir: path.join(rootDir, "stash"),
    manifestPath: path.join(rootDir, "manifest.json"),
  };
}

export function validateWebsiteUrl(rawUrl: string, options?: WebsiteUrlValidationOptions): string {
  return validateWebsiteUrlWithError(rawUrl, ConfigError, options);
}

export function validateWebsiteInputUrl(rawUrl: string, options?: WebsiteUrlValidationOptions): string {
  return validateWebsiteUrlWithError(rawUrl, UsageError, options);
}

function validateWebsiteUrlWithError(
  rawUrl: string,
  ErrorType: typeof ConfigError | typeof UsageError,
  options?: WebsiteUrlValidationOptions,
): string {
  if (!rawUrl) {
    throw new ErrorType("Website provider requires a URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ErrorType(`Website URL is not valid: "${rawUrl}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ErrorType(`Website URL must use http:// or https://, got "${parsed.protocol}" in "${rawUrl}"`);
  }
  if (parsed.username || parsed.password) {
    throw new ErrorType("Website URL must not contain embedded credentials");
  }
  assertWebsiteRequestUrl(parsed.toString(), ErrorType, options);

  parsed.hash = "";
  return normalizeSiteUrl(parsed.toString());
}

export function normalizeSiteUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}
