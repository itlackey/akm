# Registry network boundary

All HTTP(S) traffic used to discover or install registry content passes
through `fetchRegistry` / `fetchRegistryJson` in `src/registry/network.ts`.
The boundary is plain `fetch()` plus a request timeout, bounded retries on
network failure / timeout / 429 / 5xx (honoring a capped `Retry-After`), a
byte cap on the response body, and classified errors: a request that fails
after retries, or whose body can't be used, always leaves as an `AkmError` —
never a raw, unclassified exit 70.

- Not found / unusable response (HTTP 404/410, or a body that isn't valid
  JSON / isn't shaped as expected) -> `NotFoundError` (exit 1).
- Every other non-2xx status, and connection failure / timeout after retries
  are exhausted -> `TransientError` (`REGISTRY_UNREACHABLE`, exit 75).
- A malformed registry URL, an embedded `user:pass@`, or a non-http(s) scheme
  -> `ConfigError` (`REGISTRY_URL_INVALID`, exit 78).

Callers: `src/registry/providers/static-index.ts`, `providers/skills-sh.ts`,
`src/registry/resolve.ts` (npm and GitHub metadata), `src/setup/registry-stash-loader.ts`,
and `src/sources/providers/provider-utils.ts`'s `downloadArchive` (npm tarball
download, used by `sources/providers/npm.ts`). Credentials (a resolved GitHub
token, etc.) are injected by the caller as ordinary `headers` on the request —
this module does not resolve credentials itself. HTTPS is not required by
`fetchRegistry` itself: `--allow-insecure-transport`/HTTPS enforcement happens
once, where a URL enters configuration (`akm registry add`, `akm bundle add`),
per `AGENTS.md`'s "Unsafe CLI overrides" policy.

## What this boundary does *not* do

Earlier releases pinned every registry request's DNS resolution: they
resolved and classified the hostname's A/AAAA answers, rejected loopback /
private / link-local / cloud-metadata / reserved addresses, connected to the
one validated numeric address (never re-resolving at connect time), and
re-validated on every retry and redirect hop. Because Bun's fetch client
cannot pin a TLS connection to a literal address while retaining SNI, that
DNS-pinned transport spawned a short-lived Node child process per request to
do the actual connect, over a bounded stdin/stdout framing protocol.

That pinning, and the subprocess that implemented it
(`pinned-transport.ts`, `pinned-request-helper.ts`), were deleted as
over-engineering for this codebase's actual threat model: registry URLs are
either the built-in registry or a URL an operator explicitly configured
(`akm registry add`, `AKM_REGISTRY_URL`, `AKM_NPM_REGISTRY`) — a deliberate
human command, not third-party input akm fetches on an untrusted caller's
behalf (see `AGENTS.md`'s "Defensive Code" test 3). The subprocess-per-request
design was also the direct cause of registry network failures surfacing as an
unclassified exit 70 instead of a typed error, a symptom fixed repeatedly
before this simplification (see CHANGELOG history around the registry HTTP
stack). `src/core/network-policy.ts`'s address classifier is unrelated to this
boundary now; it still backs the `website` source provider's own SSRF guard
(`src/sources/snapshot-fetchers/host-guard.ts`), which fetches arbitrary
operator-pasted URLs and keeps its own justification for that guard.

Registry-derived `source: git` entries are still rejected before an install
ref can reach `git ls-remote` or clone — that check lives in
`src/registry/providers/static-index.ts` and is independent of the network
boundary.
