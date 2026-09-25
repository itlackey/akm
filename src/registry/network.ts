// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  abortableDelay,
  backoffDelay,
  computeRetryDelay,
  jsonWithByteCap,
  ResponseTooLargeError,
  shouldRetry,
  toErrorMessage,
} from "../core/common";
import { ConfigError, NotFoundError, TransientError } from "../core/errors";
import { formatRegistryUrl } from "../core/registry-url";

/**
 * The one HTTP boundary for registry traffic: static indexes, the skills.sh
 * API, npm and GitHub metadata, and npm tarballs all go through here.
 *
 * It is plain `fetch()` plus the four things every caller needs and nothing
 * else: a total request timeout, bounded retries on transient failures, the
 * caller's headers (credentials are resolved by the caller — see
 * `githubHeaders`), and classified errors. Every failure leaves as an
 * `AkmError`, so the CLI exits 1 (not found / unusable response), 75
 * (transient) or 78 (bad URL) — never 70.
 *
 * Redirects are followed by the runtime. Plain HTTP is accepted here: the
 * HTTPS-unless-`--allow-insecure-transport` rule is enforced where URLs enter
 * configuration (`akm registry add`, `akm bundle add`), and every URL that
 * reaches this function is either one the operator configured or one derived
 * from an operator-configured origin.
 */
export interface FetchRegistryOptions {
  headers?: HeadersInit;
  /** One budget, in milliseconds, for the connection, the headers and the body. */
  timeoutMs?: number;
  /** Extra attempts after a network failure, a timeout, a 429 or a 5xx. */
  retries?: number;
  /** Caller cancellation. A caller abort is rethrown as-is and never retried. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_JSON_BYTE_CAP = 10 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 30_000;

/** Fetch a registry URL. Resolves only to a 2xx response; every other outcome throws an `AkmError`. */
export async function fetchRegistry(rawUrl: string, options: FetchRegistryOptions = {}): Promise<Response> {
  const url = parseRegistryUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    // AbortSignal.timeout() does not keep the event loop alive, and it keeps
    // covering the body after this function returns.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(rawUrl, { headers: options.headers, signal, redirect: "follow" });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (attempt < retries) {
        await abortableDelay(backoffDelay(attempt, undefined, MAX_RETRY_DELAY_MS), options.signal);
        continue;
      }
      const reason = timeout.aborted ? `timed out after ${timeoutMs}ms` : `failed: ${toErrorMessage(error)}`;
      throw new TransientError(`Registry request to ${url.host} ${reason} (${rawUrl})`, "REGISTRY_UNREACHABLE");
    }

    if (attempt < retries && shouldRetry(response.status)) {
      await cancelBody(response);
      await abortableDelay(computeRetryDelay(response, attempt, { maxDelayMs: MAX_RETRY_DELAY_MS }), options.signal);
      continue;
    }
    if (response.ok) return response;
    await cancelBody(response);
    throw statusError(response.status, rawUrl);
  }
}

/** `fetchRegistry` plus a JSON body read under a byte cap. */
export async function fetchRegistryJson<T = unknown>(
  rawUrl: string,
  options: FetchRegistryOptions & { maxBytes?: number } = {},
): Promise<T> {
  const response = await fetchRegistry(rawUrl, options);
  try {
    return await jsonWithByteCap<T>(response, options.maxBytes ?? DEFAULT_JSON_BYTE_CAP, {
      bodyTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof ResponseTooLargeError || error instanceof SyntaxError) {
      throw new NotFoundError(
        `Registry response from ${rawUrl} is not usable: ${toErrorMessage(error)}`,
        "REGISTRY_RESPONSE_INVALID",
      );
    }
    throw new TransientError(
      `Registry response from ${rawUrl} could not be read: ${toErrorMessage(error)}`,
      "REGISTRY_UNREACHABLE",
    );
  }
}

function parseRegistryUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`Registry URL is not a valid URL: ${formatRegistryUrl(rawUrl)}`, "REGISTRY_URL_INVALID");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(
      `Registry URL must use http(s), not ${url.protocol || "an empty scheme"}: ${formatRegistryUrl(rawUrl)}`,
      "REGISTRY_URL_INVALID",
    );
  }
  if (url.username || url.password) {
    throw new ConfigError(`Registry URL must not embed credentials: ${url.origin}`, "REGISTRY_URL_INVALID");
  }
  return url;
}

function statusError(status: number, rawUrl: string): NotFoundError | TransientError {
  const message = `Registry request failed (HTTP ${status}) for ${rawUrl}`;
  if (shouldRetry(status)) return new TransientError(message, "REGISTRY_UNREACHABLE");
  if (status === 404 || status === 410) return new NotFoundError(message, "REGISTRY_NOT_FOUND");
  const hint =
    status === 401 || status === 403
      ? "The registry refused the request. For GitHub, set GITHUB_TOKEN or sign in with `gh auth login`; akm's registry providers send no other credentials."
      : undefined;
  return new NotFoundError(message, "REGISTRY_RESPONSE_INVALID", hint);
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
