// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954 (refined by the 2026-09-09 owner field-review addendum): a slow or dead
 * embedding provider used to grind through every remaining batch, one
 * (now-configurable, previously fixed 30s) timeout at a time, for however
 * many batches the run had — hours, on the reporting install's 24,041-entry
 * stash. A request timeout no longer drops its batch outright: it backs off
 * and retries the SAME request once, and only a SECOND timeout splits it (or,
 * for a single document, finally skips it) — the field evidence was that
 * akm abandoning a timed-out request does not stop llama-server from still
 * computing it, so dropping it immediately just let the provider's queue
 * grow while every following batch died the same way. After 3 consecutive
 * failures at single-document size (timeout or network error) — or 3
 * consecutive network errors at any size — the embedding phase stops
 * dispatching further requests.
 *
 * A real Bun.serve server whose fetch handler never resolves removes any
 * timing race between the client's timeout and a server that merely
 * responds late — the client's own `embedding.timeoutMs` is the only way the
 * request ever settles (see tests/integration/reflect-propose-http-timeout.test.ts
 * for the same pattern). This opens a real index.db via `akmIndex`, so it is
 * an integration test per the ORG-03..06 classification rule.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { clearEmbeddingCache } from "../../src/llm/embedders/cache";
import { _setEmbeddingTimeoutBackoffForTests } from "../../src/llm/embedders/remote";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  clearEmbeddingCache();
});
afterEach(() => {
  server?.stop(true);
  server = undefined;
  storage.cleanup();
  resetConfigCache();
});

function writeMemory(name: string): void {
  // Deliberately no body content: a non-empty body would derive a SECOND
  // (fragment) unit alongside the card unit (index-redesign B2/B3), doubling
  // the document count these tests dispatch per entry and desyncing the
  // hand-traced request-count/request-size sequences below from the
  // documents actually sent. Frontmatter-only keeps it at exactly one unit
  // (the card) per entry, matching this file's "N entries = N documents"
  // accounting.
  fs.writeFileSync(path.join(storage.stashDir, "memories", name), `---\ndescription: ${name}\n---\n`, "utf8");
}

function isProbeRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === "/props" || pathname === "/api/show";
}

/** Minimum gap (ms) between a document's two requests that only a real back-off (not an immediate retry) can produce. */
const MIN_PROVEN_BACKOFF_MS = 2_000;

/**
 * A single large memory entry whose CARD unit (structured-fields text —
 * `${name}\n${description}`, no markdown body so no second fragment unit is
 * derived, same rationale as `writeMemory` below) is, by itself, too big to
 * ever share a request with a sibling: the index redesign (B5) retired
 * `embedding.batchSize` as a config config key, so this test's premise
 * ("already at single-document size", no splitting needed to get there) now
 * has to come from the GREEDY packer's own token-budget math against the
 * default (unprobed, 8192-token) window instead of a config override.
 * `DESCRIPTION_CHARS` (17,000) estimates to ~4,252 tokens
 * (`estimateTokenCount`, chars/4) — under `unitMaxChars`'s ~21,132-char
 * ceiling for this same window (so it stays ONE undivided unit), but over
 * half the 8,192-token budget, so two of them together (~8,504) never fit
 * one request.
 */
const DESCRIPTION_CHARS = 17_000;

function writeLargeMemory(name: string): void {
  fs.writeFileSync(
    path.join(storage.stashDir, "memories", name),
    `---\ndescription: ${"x".repeat(DESCRIPTION_CHARS)}\n---\n`,
    "utf8",
  );
}

test("stops after exactly 3 consecutive single-document timeouts against a dead endpoint and reports it, with endpoint guidance", async () => {
  let requestCount = 0;
  const requestTimestamps: number[] = [];
  server = Bun.serve({
    port: 0,
    fetch(request) {
      // The pre-flight /props (llama.cpp) / /api/show (Ollama) provider-limits
      // probe (probeProviderLimits, called once before any embedding request)
      // must not count toward this test's dead-endpoint request accounting —
      // it is answered immediately, not left to hang like a real embedding
      // request.
      if (isProbeRequest(request)) return new Response(null, { status: 404 });
      requestCount++;
      requestTimestamps.push(Date.now());
      // Never resolves: the client's own embedding.timeoutMs is the only
      // way each request can ever settle (see module docstring).
      return new Promise<Response>(() => {});
    },
  });

  for (let i = 0; i < 5; i++) writeLargeMemory(`entry-${i}.md`);

  writeSandboxConfig({
    semanticSearchMode: "auto",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    embedding: {
      endpoint: `http://localhost:${server.port}`,
      model: "test-model",
      dimension: 4,
      timeoutMs: 300,
    },
  });
  resetConfigCache();

  const result = await akmIndex({ stashDir: storage.stashDir, full: true });

  // Each single-document batch is already at single-document size, so it
  // gets the one same-size retry (never a split) before it
  // finally counts as a failure: 2 requests per document, 3 documents to
  // trip the breaker (the other 2 documents' batches are never dispatched
  // at all) = 6 requests, not the pre-retry-backoff 3.
  expect(requestCount).toBe(6);
  // Request-timing log proving each retry actually waited out a back-off
  // rather than firing immediately: the 2nd request of every pair lands at
  // least MIN_PROVEN_BACKOFF_MS after the 1st.
  for (let i = 0; i < requestTimestamps.length; i += 2) {
    const gap = (requestTimestamps[i + 1] as number) - (requestTimestamps[i] as number);
    expect(gap).toBeGreaterThanOrEqual(MIN_PROVEN_BACKOFF_MS);
  }
  expect(result.verification.ok).toBe(false);
  expect(result.verification.semanticStatus).toBe("blocked");
  // index-redesign (B5a): the old materialize-embeddings path's
  // breaker-specific wording ("embedding provider failed N consecutive
  // batches") no longer exists — buildIndexVerification (indexer.ts) reports
  // the same "blocked, 0 embeddings, actionable guidance" outcome through
  // its own generic no-progress message instead. What must still hold is the
  // underlying, never-lie invariant: no embeddings stored, and guidance that
  // names the endpoint as the thing to check.
  expect(result.verification.message).toContain("verification failed");
  expect(result.verification.embeddingCount).toBe(0);
  // verifyIndexState's guidance for a remote provider names the endpoint as
  // the thing to check.
  expect(result.verification.guidance).toContain("embedding endpoint");
}, 60_000);

test("a dead endpoint splits a multi-document batch down to singles before any failure counts, tripping after exactly 3 single-document failures", async () => {
  // #954 field-report follow-up: the backoff base/max is overridden small
  // here so the test stays fast — the growing-delay behavior under test is
  // proportional to `embeddingTimeoutRetryBackoffMs`'s attempt/base/max
  // inputs, not to any specific real-world duration.
  const BACKOFF_BASE_MS = 200;
  overrideSeam(_setEmbeddingTimeoutBackoffForTests, { baseMs: BACKOFF_BASE_MS, maxMs: 5_000 });

  let requestCount = 0;
  const requestSizes: number[] = [];
  const requestTimestamps: number[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      // See the single-document test above: the pre-flight limits probe
      // must not be counted as a dispatched embedding request.
      if (isProbeRequest(request)) return new Response(null, { status: 404 });
      requestCount++;
      requestTimestamps.push(Date.now());
      const body = (await request.json().catch(() => ({ input: [] }))) as { input?: string[] };
      requestSizes.push(body.input?.length ?? 0);
      // Never resolves: same rationale as the single-document test above.
      return new Promise<Response>(() => {});
    },
  });

  for (let i = 0; i < 3; i++) writeMemory(`entry-${i}.md`);

  writeSandboxConfig({
    semanticSearchMode: "auto",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    embedding: {
      endpoint: `http://localhost:${server.port}`,
      model: "test-model",
      dimension: 4,
      // No batchSize override: all 3 tiny documents land in ONE provider
      // batch, so this exercises the actual split-down-to-
      // singles recursion rather than starting pre-split like the test
      // above.
      timeoutMs: 300,
    },
  });
  resetConfigCache();

  const result = await akmIndex({ stashDir: storage.stashDir, full: true });

  // Sequence: size 3 (retry, still times out) -> split into size 2 + size 1.
  // Size 2 (retry, still times out) -> split into size 1 + size 1: two
  // single-document failures (#1, #2). Back up to the outer size-1 half:
  // its own retry-then-timeout is the 3rd single-document failure, which
  // trips the breaker — no batch above single-document size ever counts
  // toward the breaker by itself (context-size logic aside), only once
  // retries have narrowed it down to one document.
  expect(requestSizes).toEqual([3, 3, 2, 2, 1, 1, 1, 1, 1, 1]);
  expect(requestCount).toBe(10);
  // Request-timing log proving the back-off DELAYS GROW down the split
  // chain (#954 field-report follow-up) rather than every retry using the
  // same flat ~5s floor: `timeoutAttempt` is 0 for the top-level size-3
  // retry, 1 for each size-2/size-1 branch a first split produces, and 2 for
  // the two single-document branches a second split produces off the size-2
  // half — so the five retry pairs below, in dispatch order, back off at
  // attempts [0, 1, 2, 2, 1]. `backoffDelay`'s floor at one attempt is
  // `baseMs * 2^attempt * 0.5`, strictly increasing per attempt and never
  // reduced by jitter, so asserting each pair against its own attempt's
  // floor proves genuine growth rather than a single shared threshold.
  const expectedAttemptByRetryPair = [0, 1, 2, 2, 1];
  expect(requestTimestamps.length).toBe(expectedAttemptByRetryPair.length * 2);
  for (const [pairIndex, attempt] of expectedAttemptByRetryPair.entries()) {
    const i = pairIndex * 2;
    const gap = (requestTimestamps[i + 1] as number) - (requestTimestamps[i] as number);
    const floor = BACKOFF_BASE_MS * 2 ** attempt * 0.5;
    expect(gap).toBeGreaterThanOrEqual(floor);
  }
  expect(result.verification.ok).toBe(false);
  expect(result.verification.semanticStatus).toBe("blocked");
  // See the single-document test above for why the message assertion is
  // now generic rather than breaker-specific wording.
  expect(result.verification.message).toContain("verification failed");
  expect(result.verification.embeddingCount).toBe(0);
  expect(result.verification.guidance).toContain("embedding endpoint");
}, 60_000);
