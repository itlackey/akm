// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fetchWithRetry, readBodyWithByteCap } from "../../core/common";
import {
  bareHostname,
  classifyNetworkAddress,
  classifyNetworkHostname,
  type HostnameResolver,
  resolveHostnameAddresses,
} from "../../core/network-policy";

/**
 * SSRF host guards and the guarded fetch used by every outbound request the
 * website subsystem makes.
 *
 * Extracted from `website-ingest.ts` into a leaf module so the snapshot
 * fetchers can share it: a fetcher importing `website-ingest` directly would
 * cycle, because `website-ingest` imports the fetcher registry.
 */

/** Options accepted by the host guards. */
export interface HostGuardOptions {
  /** Test-only: permit loopback/private hosts. Never set in production. */
  allowPrivateHosts?: boolean;
  /** Injectable DNS resolver so tests never perform a real lookup. */
  resolveHostname?: HostnameResolver;
}

/** Resolve a hostname to its A/AAAA address strings. Injectable for tests. */
export type { HostnameResolver } from "../../core/network-policy";

export interface GuardedResponse {
  response: Response;
  finalUrl: string;
}

/** Redirect budget for a single guarded request chain. */
const MAX_GUARDED_REDIRECTS = 8;

export type WebsiteUrlErrorCtor = new (message: string) => Error;

export function assertWebsiteRequestUrl(
  rawUrl: string,
  ErrorType: WebsiteUrlErrorCtor = Error,
  options?: HostGuardOptions,
): void {
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.username || parsedUrl.password) {
    throw new ErrorType(`Refusing to fetch URL with embedded credentials: ${parsedUrl.hostname}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ErrorType(`Refusing to fetch non-http(s) URL on host: ${parsedUrl.hostname}`);
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname.endsWith(".invalid")) {
    throw new ErrorType(`Refusing to fetch reserved invalid hostname: ${parsedUrl.hostname}`);
  }
  if (isForbiddenWebsiteHostname(hostname, options)) {
    throw new ErrorType(`Refusing to fetch non-public website host: ${parsedUrl.hostname}`);
  }
}

/**
 * Resolve-then-validate SSRF guard against DNS rebinding / private-range
 * bypasses. {@link assertWebsiteRequestUrl} only rejects IP-literal and
 * well-known-name hosts; a hostname like `private-host.example.com` that
 * resolves to `10.0.0.1` passes those checks and then fetch connects to the
 * private address. Here we resolve EVERY A/AAAA record and validate each
 * against the same forbidden-range rules, failing CLOSED on an empty answer or
 * resolver error.
 *
 * TOCTOU residual (documented, not fully closable here): Bun's `fetch` exposes
 * no custom `lookup`/agent hook, so we cannot pin the socket to the exact IP we
 * validated — a hostile resolver could return a public IP to this lookup and a
 * private IP microseconds later at connect time (classic rebinding). This still
 * removes the TRIVIAL `hostname A 10.0.0.1` bypass, which is the strongest
 * guarantee available without a pinned-connection fetch API. Re-run on every
 * redirect hop (the crawler recurses through `fetchWebsiteResponse`).
 */
export async function assertResolvedHostAllowed(hostname: string, options?: HostGuardOptions): Promise<void> {
  if (options?.allowPrivateHosts === true) return;
  const bare = bareHostname(hostname.toLowerCase());
  const literalClass = classifyNetworkAddress(bare);
  if (literalClass !== "invalid") {
    if (literalClass !== "public") throw new Error(`Refusing to fetch non-public website host: ${hostname}`);
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolveHostnameAddresses(bare, options?.resolveHostname);
  } catch {
    throw new Error(`Refusing to fetch ${hostname}: DNS resolution failed`);
  }
  if (addresses.length === 0) {
    throw new Error(`Refusing to fetch ${hostname}: hostname resolved to no addresses`);
  }
  for (const address of addresses) {
    if (classifyNetworkAddress(address) !== "public") {
      throw new Error(`Refusing to fetch ${hostname}: resolves to non-public or unparseable address ${address}`);
    }
  }
}

function isForbiddenWebsiteHostname(hostname: string, options?: HostGuardOptions): boolean {
  if (options?.allowPrivateHosts === true) return false;
  return classifyNetworkHostname(hostname) !== "public";
}

function redirectInit(init: RequestInit, currentUrl: string, nextUrl: string): RequestInit {
  if (new URL(currentUrl).origin === new URL(nextUrl).origin) return init;
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return { ...init, headers };
}

/**
 * Fetch with the full SSRF guard chain applied to the initial URL and to every
 * redirect hop.
 *
 * `redirect: "manual"` is essential: with the default `follow`, the platform
 * resolves and connects to redirect targets that were never validated, so a
 * public host can bounce a request into the private network.
 */
export async function fetchGuardedResponse(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; retries?: number } & HostGuardOptions,
  redirectCount = 0,
): Promise<GuardedResponse> {
  assertWebsiteRequestUrl(url, Error, opts);
  await assertResolvedHostAllowed(new URL(url).hostname, opts);

  const response = await fetchWithRetry(
    url,
    { ...init, redirect: "manual" },
    {
      timeout: opts.timeoutMs,
      retries: opts.retries ?? 1,
    },
  );

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= MAX_GUARDED_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Too many redirects while fetching ${url}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Redirect response from ${url} did not include a Location header`);
    }
    await response.body?.cancel().catch(() => undefined);
    const nextUrl = new URL(location, url).toString();
    return fetchGuardedResponse(nextUrl, redirectInit(init, url, nextUrl), opts, redirectCount + 1);
  }

  return { response, finalUrl: url };
}

/** Options for fixed-host API reads that must reject redirects. */
export interface PinnedTextOptions {
  headers: HeadersInit;
  byteCap: number;
  bodyTimeoutMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  retries?: number;
}

export type PinnedJsonOptions = PinnedTextOptions;

/**
 * GET text from a compile-time fixed API host, rejecting redirects so request
 * headers (which may contain a token) can never be forwarded elsewhere.
 */
export async function fetchPinnedText(url: string, options: PinnedTextOptions): Promise<string | null> {
  const response = await fetchWithRetry(
    url,
    { headers: options.headers, signal: options.signal, redirect: "manual" },
    { timeout: options.timeoutMs, retries: options.retries ?? 1 },
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return await readBodyWithByteCap(response, options.byteCap, {
      bodyTimeoutMs: options.bodyTimeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return null;
  }
}

/**
 * GET a JSON document from a PINNED, constant API host (X, Bluesky XRPC), with
 * a byte-capped read. Returns the parsed value, or null on any 3xx/non-2xx/
 * parse failure.
 *
 * `redirect: "manual"` + rejecting 3xx is load-bearing: these endpoints have no
 * legitimate reason to redirect, and following one would send the next request
 * (bearer token included) to an unvalidated host with none of the SSRF guards
 * the crawl path applies. The full resolve-then-validate DNS guard is
 * intentionally NOT applied here because the host is a compile-time constant,
 * not caller-supplied — the guarded chokepoint is {@link fetchGuardedResponse},
 * which the caller-supplied crawl/feed paths use instead.
 */
export async function fetchPinnedJson(url: string, options: PinnedJsonOptions): Promise<unknown | null> {
  const body = await fetchPinnedText(url, options);
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
