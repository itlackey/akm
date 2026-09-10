// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Loopback classification for LLM endpoints: does this endpoint name a model
 * server running on THIS machine? A host is loopback when it is `localhost` or
 * a `*.localhost` name (RFC 6761 §6.3), anywhere in `127.0.0.0/8`, an
 * unspecified address (`0.0.0.0` / `::` — a client connecting there reaches
 * local loopback), IPv6 `::1`, or the dotted IPv4-mapped spelling of a
 * `127.0.0.0/8` address (`::ffff:127.0.0.1`). Address shapes are validated by
 * `node:net`'s `isIP`, so a near-miss NAME like `127.0.0.1.evil.com` is remote.
 *
 * The check is purely syntactic — no DNS, no interface list — so the same
 * config classifies the same on a laptop, on CI, and on a machine with no
 * network. Ambiguity resolves toward LOOPBACK: misclassifying a local server
 * as remote widens a concurrency pool onto a single-threaded local model
 * (one loaded model, reload thrash, HTTP 500 — a hard failure); the reverse
 * only costs throughput. The remedy in either direction is one line of config:
 * `engines.<name>.concurrency`.
 *
 * The ONE local-vs-remote answer for concurrency defaults — the workflow
 * engine's frozen engine concurrency (`workflows/concurrency-policy.ts`) and
 * the indexer's LLM pool (`indexer/indexer.ts` `getDefaultLlmConcurrency`)
 * both classify through here. NOT shared with the website snapshot fetcher's
 * SSRF policy (`sources/snapshot-fetchers/host-guard.ts`), which deliberately
 * draws different lines for a different threat model.
 *
 * @module core/loopback
 */

import { isIP } from "node:net";

/**
 * The IPv4-mapped IPv6 spellings of `127.0.0.0/8`: the dotted form, whose
 * capture is validated by `isIP`, and the hex form `::ffff:7fxx:xxxx`. Both are
 * needed because WHATWG `URL` re-serializes `[::ffff:127.0.0.1]` to the hex
 * form, so an endpoint written the dotted way arrives here as hex.
 */
const IPV4_MAPPED_IPV6 = /^::ffff:(?:([\d.]+)|7f[\da-f]{2}:[\da-f]{1,4})$/;
/** IPv6 groups before the last one, all of which must be zero (or elided). */
const ZERO_GROUP = /^0+$/;
/** The last IPv6 group of `::` / `::1`, in any zero-padding. */
const LOOPBACK_LAST_GROUP = /^0*[01]?$/;

/**
 * True when `host` — a URL host component, with or without IPv6 brackets —
 * names this machine WITHOUT resolving anything.
 *
 * Not recognized: the IPv4-compatible form (`::127.0.0.1`), and any NAME that
 * merely resolves to loopback.
 *
 * Exported for the boundary-case table in
 * `tests/workflows/concurrency-defaults.test.ts`, which has to reach the host
 * predicate directly: several of its cases (a bare `""`, a malformed literal
 * like `1::2::3`) cannot round-trip through a URL without changing meaning.
 */
export function isLoopbackHost(host: string): boolean {
  // Strip IPv6 brackets (`URL.hostname` keeps them) and the DNS root label. An
  // empty host (`new URL("localhost:1234")` parses as scheme `localhost:` with
  // no host) has nothing to judge, so it fails safe like an unparseable one.
  const name = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (name === "" || name === "localhost" || name.endsWith(".localhost")) return true;
  const mapped = IPV4_MAPPED_IPV6.exec(name);
  if (mapped) {
    const quad = mapped[1];
    // The hex branch already matched 127.x in the pattern; the dotted one still
    // needs `isIP` so `::ffff:127.0.0.256` stays remote.
    return quad === undefined || (isIP(quad) === 4 && quad.startsWith("127."));
  }
  const version = isIP(name);
  if (version === 4) return name.startsWith("127.") || name === "0.0.0.0";
  if (version !== 6) return false;
  const groups = name.split(":");
  const last = groups.pop() ?? "";
  return groups.every((group) => group === "" || ZERO_GROUP.test(group)) && LOOPBACK_LAST_GROUP.test(last);
}

/** True when `endpoint` points at this machine (see {@link isLoopbackHost}). */
export function isLoopbackEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try {
    return isLoopbackHost(new URL(endpoint).hostname);
  } catch {
    // An unparseable endpoint is treated as local: guessing "remote" here would
    // widen the pool on exactly the configs we understand least.
    return true;
  }
}

/**
 * The lowest-common-denominator concurrency default for an LLM/embedding
 * endpoint: 1 for a loopback endpoint (a local model server serves one
 * inference at a time; concurrent requests thrash it — reload thrash, HTTP
 * 500 "Model reloaded"), 2 for a remote one (enough to overlap request
 * latency without hammering a rate-limited API). A leaf helper so both
 * callers — the indexer's LLM enrichment pool (`getDefaultLlmConcurrency`,
 * `src/indexer/indexer.ts`) and the embedding pool
 * (`resolveEmbeddingConcurrency`, `src/llm/embedders/remote.ts`) — share one
 * definition instead of mirroring it; `src/llm/embedders/remote.ts` cannot
 * import `getDefaultLlmConcurrency` directly (`src/indexer/indexer.ts`
 * already depends on this module transitively through
 * materialize-embeddings.ts).
 */
export function defaultConcurrencyForEndpoint(endpoint: string | undefined): 1 | 2 {
  return isLoopbackEndpoint(endpoint) ? 1 : 2;
}
