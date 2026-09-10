// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The embedding provider's OWN limits — real context window and in-flight
 * slot count — read from the endpoint itself rather than guessed from
 * config (docs/plans/index-fragment-vectors.md, rule 3: "The limits are the
 * provider's"). Two shapes are recognised: llama.cpp's `GET /props`
 * (window, slots), with `/tokenize` when present used internally to
 * calibrate `charsPerToken`; and Ollama's `POST /api/show` (window only —
 * `num_parallel` is not exposed, so slots is always 1 unless
 * `config.concurrency` overrides it). Any other endpoint (an
 * OpenAI-compatible server, a gateway such as Bifrost) reports neither, so a
 * conservative default stands in.
 *
 * `probeProviderLimits` never throws: a probe that fails for any reason
 * (unreachable endpoint, malformed response, a provider that reports
 * nothing recognisable) resolves to the same `source: "default"` shape a
 * misconfigured or exotic endpoint would get. The result is memoised per
 * process (keyed by endpoint/model/concurrency/timeoutMs, see the
 * module-level cache below), since `reconcileRoots`, `reconcilePaths` and
 * `drainEmbeddingQueue` each call it and a probe is otherwise several HTTP
 * requests every caller would repeat.
 *
 * Wired into the embedding loop by `src/indexer/drain.ts`, which threads the
 * result in as `RemoteEmbedder.embedBatch`'s `packing` option
 * (`EmbeddingRequestPacking`, `src/llm/embedders/remote.ts`) — the
 * `embedding.maxInputTokens`/`maxTokens`/`batchSize`/`contextLength` config
 * keys this replaced are retired (docs/plans/index-redesign-contract.md, B5).
 */

import type { EmbeddingConnectionConfig } from "../../core/config/config";
import { HEALTH_PROBE_TIMEOUT_MS } from "../client";

/** The provider's real limits, as observed (or defaulted) by {@link probeProviderLimits}. */
export interface ProviderLimits {
  /** Real tokens one request may carry: llama.cpp's `n_ctx`, Ollama's `<arch>.context_length`, or {@link DEFAULT_WINDOW_TOKENS}. */
  windowTokens: number;
  /** Requests the server can hold in flight. */
  slots: number;
  source: "llama.cpp" | "ollama" | "default";
  /**
   * Chars-per-token ratio used to turn `windowTokens` into a character
   * bound ({@link unitMaxChars}) and, downstream, into `RemoteEmbedder`'s
   * per-request token estimate. Calibrated against this provider/model via
   * its own tokenizer when it exposes one (llama.cpp's `/tokenize` — see
   * {@link calibrateCharsPerToken}); the fixed {@link CHARS_PER_TOKEN_TAIL}
   * fallback otherwise. The tokenizer itself is never part of this returned
   * shape — it is used once, internally, to compute this ratio.
   */
  charsPerToken: number;
}

/**
 * Window assumed for a provider that reports nothing about its own context
 * size (an OpenAI-compatible server, a gateway such as Bifrost): the most
 * common embedding window; the same-run adaptive shrink already in
 * `src/llm/embedders/remote.ts` corrects an overestimate.
 */
export const DEFAULT_WINDOW_TOKENS = 8_192;

/**
 * Chars-per-token ratio assumed when the provider exposes no exact
 * tokenizer to calibrate against: field-measured p99 on dense markdown
 * (#954, the same field evidence `DEFAULT_TOKEN_BUDGET` in
 * `src/llm/embedders/remote.ts` was tuned against).
 */
export const CHARS_PER_TOKEN_TAIL = 2.6;

/**
 * Reserves room, inside the provider's own token window, for the one-line
 * header every unit's text is prefixed with (entry name, or
 * "entry name › section title" — see A1's `deriveUnits`), so a unit's
 * header plus body never together exceed the real window. 64 tokens
 * comfortably covers a realistic header without materially shrinking the
 * usable window on a small-context provider.
 */
export const UNIT_HEADER_MARGIN_TOKENS = 64;

/**
 * Percentile (of chars-per-token ratios, sorted ascending) calibration
 * reports: the single densest sampled text, i.e. the smallest
 * chars-per-token ratio — the same conservative, worst-case-density intent
 * the {@link CHARS_PER_TOKEN_TAIL} fallback encodes as a fixed p99. Over
 * {@link CALIBRATION_SHAPES}' eight samples this percentile always resolves
 * to index 0 — it is simply the minimum ratio observed.
 */
const CALIBRATION_PERCENTILE = 0.01;

/** Content posted to `/tokenize` purely to check the route exists, before spending the full calibration corpus on it. */
const TOKENIZE_PRESENCE_PROBE_TEXT = "ping";

/**
 * Representative text shapes to calibrate a provider's chars-per-token
 * ratio against, tokenized once each (eight requests total): mirrors the
 * mix real markdown fragments produce — prose, code, a table, a list, a
 * link, non-Latin text (which tokenizes at a very different ratio than
 * English prose), SQL, and dense technical prose.
 */
const CALIBRATION_SHAPES: readonly string[] = [
  "This is a short sentence describing typical prose content used to calibrate the tokenizer.",
  "```ts\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```",
  "| Column A | Column B | Column C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |",
  "- first item in a list\n- second item in a list\n- third item, a little longer than the rest",
  "See [the reference documentation](https://example.com/docs/reference) for more detail on this API.",
  "日本語のテキストは英語と比べてトークンあたりの文字数が大きく異なることがあります。",
  "SELECT id, name, description FROM entries WHERE tags LIKE '%embedding%' ORDER BY updated_at DESC LIMIT 50;",
  "A longer paragraph mixing punctuation, numbers (like 42 and 3.14), and technical terms such as `tokenizer`, `embedding`, and `context window`.",
];

/** Index into a `length`-element array, sorted ascending, at `percentile` (0-1). Clamped so a tiny array still yields a valid index. */
function percentileIndex(length: number, percentile: number): number {
  if (length <= 1) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor((length - 1) * percentile)));
}

/**
 * Calibrate `charsPerToken` against a real provider/model by tokenizing
 * {@link CALIBRATION_SHAPES} once each and taking the
 * {@link CALIBRATION_PERCENTILE} (densest-text) chars-per-token ratio across
 * them — with eight samples that percentile is simply the minimum ratio
 * observed. A sample whose tokenize call fails is skipped rather than
 * aborting the whole calibration; only a total wipeout (every sample
 * failed) falls back to {@link CHARS_PER_TOKEN_TAIL}.
 */
async function calibrateCharsPerToken(countTokens: (text: string) => Promise<number>): Promise<number> {
  const ratios: number[] = [];
  for (const text of CALIBRATION_SHAPES) {
    try {
      const tokens = await countTokens(text);
      if (tokens > 0) ratios.push(text.length / tokens);
    } catch {
      // One bad calibration sample must not abort the whole probe.
    }
  }
  if (ratios.length === 0) return CHARS_PER_TOKEN_TAIL;
  ratios.sort((a, b) => a - b);
  return ratios[percentileIndex(ratios.length, CALIBRATION_PERCENTILE)] as number;
}

/** GET/POST `url` bounded by `timeoutMs`, additionally aborting if `externalSignal` fires. Never throws on timeout/abort itself — that surfaces as a normal fetch rejection to the caller, which every call site here already catches. */
function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  return fetchImpl(url, { ...init, signal });
}

/** Parse a response body as JSON, or `undefined` on anything that is not valid JSON — a malformed response is a failed probe, not a thrown error. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Probe llama.cpp's `/tokenize` route: one presence check with a fixed
 * short string, then (only if that succeeds) a reusable `countTokens`
 * closure. The closure deliberately does NOT carry the probe's own
 * `probeSignal` forward — that signal belongs to this one
 * `probeProviderLimits` call's lifecycle, while the returned function is
 * held onto and invoked much later (real indexing), so it is bound only to
 * its own fresh per-call timeout.
 */
async function probeLlamaCppCountTokens(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  probeSignal: AbortSignal | undefined,
): Promise<((text: string) => Promise<number>) | undefined> {
  const tokenizeOnce = (text: string, signal: AbortSignal | undefined) =>
    timedFetch(
      fetchImpl,
      `${origin}/tokenize`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) },
      timeoutMs,
      signal,
    );

  const presence = await tokenizeOnce(TOKENIZE_PRESENCE_PROBE_TEXT, probeSignal);
  if (!presence.ok) return undefined;
  const presenceBody = (await readJson(presence)) as { tokens?: unknown } | undefined;
  if (!Array.isArray(presenceBody?.tokens)) return undefined;

  return async (text: string) => {
    const res = await tokenizeOnce(text, undefined);
    if (!res.ok) throw new Error(`llama.cpp /tokenize request failed (${res.status})`);
    const json = (await readJson(res)) as { tokens?: unknown } | undefined;
    if (!Array.isArray(json?.tokens)) throw new Error("Unexpected /tokenize response: missing tokens array");
    return json.tokens.length;
  };
}

/** Shape of llama.cpp's `GET /props` response this module reads. Everything else in the real payload is ignored. */
interface LlamaCppPropsResponse {
  default_generation_settings?: { n_ctx?: unknown };
  total_slots?: unknown;
}

async function probeLlamaCpp(
  origin: string,
  config: EmbeddingConnectionConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProviderLimits | undefined> {
  const res = await timedFetch(fetchImpl, `${origin}/props`, { method: "GET" }, timeoutMs, signal);
  if (!res.ok) return undefined;
  const body = (await readJson(res)) as LlamaCppPropsResponse | undefined;
  const windowTokens = body?.default_generation_settings?.n_ctx;
  if (typeof windowTokens !== "number" || !Number.isFinite(windowTokens) || windowTokens <= 0) return undefined;

  const probedSlots = typeof body?.total_slots === "number" && body.total_slots > 0 ? body.total_slots : 1;
  const slots = config.concurrency ?? probedSlots;

  const countTokens = await probeLlamaCppCountTokens(origin, fetchImpl, timeoutMs, signal).catch(() => undefined);
  const charsPerToken = countTokens ? await calibrateCharsPerToken(countTokens) : CHARS_PER_TOKEN_TAIL;

  return { windowTokens, slots, source: "llama.cpp", charsPerToken };
}

/** Ollama does not expose `num_parallel` (its in-flight slot count) via any API route, so the probe always reports 1 slot unless `config.concurrency` overrides it. */
const OLLAMA_DEFAULT_SLOTS = 1;

/** Find `"<arch>.context_length"` in Ollama's `model_info` — the arch prefix varies per model family, so every key is checked rather than assuming one name. */
function findOllamaContextLength(modelInfo: Record<string, unknown>): number | undefined {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

async function probeOllama(
  origin: string,
  config: EmbeddingConnectionConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProviderLimits | undefined> {
  if (!config.model) return undefined;
  const res = await timedFetch(
    fetchImpl,
    `${origin}/api/show`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model }) },
    timeoutMs,
    signal,
  );
  if (!res.ok) return undefined;
  const body = (await readJson(res)) as { model_info?: Record<string, unknown> } | undefined;
  if (!body?.model_info) return undefined;
  const windowTokens = findOllamaContextLength(body.model_info);
  if (windowTokens === undefined) return undefined;

  return {
    windowTokens,
    slots: config.concurrency ?? OLLAMA_DEFAULT_SLOTS,
    source: "ollama",
    charsPerToken: CHARS_PER_TOKEN_TAIL,
  };
}

/** The origin (`scheme://host[:port]`) to probe against, or `undefined` when `endpoint` is absent, unparseable, or not http(s) — a local-only embedder (no remote `endpoint`) never touches the network. */
function resolveOrigin(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/** The probe's own per-request timeout: `config.timeoutMs` when set, else the shared health-probe default (`src/llm/client.ts`'s `HEALTH_PROBE_TIMEOUT_MS`) reused rather than redefined. */
function resolveProbeTimeoutMs(config: EmbeddingConnectionConfig): number {
  return config.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
}

function defaultLimits(config: EmbeddingConnectionConfig): ProviderLimits {
  return {
    windowTokens: DEFAULT_WINDOW_TOKENS,
    slots: config.concurrency ?? 1,
    source: "default",
    charsPerToken: CHARS_PER_TOKEN_TAIL,
  };
}

/**
 * An implausible probed window that cannot even fit its own header margin
 * plus one real character of unit text — `unitMaxChars` would floor to 0,
 * and `deriveUnits` (`src/indexer/units/unit.ts`) throws on a non-positive
 * `maxChars`. Reusing `unitMaxChars` itself as the usability test, rather
 * than a second hand-picked threshold, keeps the two in lockstep by
 * construction: a window this function accepts is, by definition, one
 * `deriveUnits` can never crash on.
 */
function isUsableWindow(limits: ProviderLimits): boolean {
  return unitMaxChars(limits) > 0;
}

async function probeProviderLimitsUncached(
  config: EmbeddingConnectionConfig,
  opts?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<ProviderLimits> {
  const origin = resolveOrigin(config.endpoint);
  if (!origin) return defaultLimits(config);

  const fetchImpl = opts?.fetch ?? fetch;
  const timeoutMs = resolveProbeTimeoutMs(config);
  const signal = opts?.signal;

  // An endpoint that answers with a window too small to be usable (at or
  // below UNIT_HEADER_MARGIN_TOKENS) is treated exactly like one that
  // reported nothing recognisable: falling through here means EVERY window
  // this module ever hands out is safe to feed straight into
  // `unitMaxChars`/`deriveUnits`, so the crash guard lives in exactly one
  // place instead of being re-defended at every downstream call site.
  const llamaCpp = await probeLlamaCpp(origin, config, fetchImpl, timeoutMs, signal).catch(() => undefined);
  if (llamaCpp && isUsableWindow(llamaCpp)) return llamaCpp;

  const ollama = await probeOllama(origin, config, fetchImpl, timeoutMs, signal).catch(() => undefined);
  if (ollama && isUsableWindow(ollama)) return ollama;

  return defaultLimits(config);
}

/**
 * Per-process memoisation of {@link probeProviderLimits}, keyed by the parts
 * of `config` that change what gets probed (`endpoint`, `model`,
 * `concurrency`, `timeoutMs`) — `reconcileRoots`, `reconcilePaths` and
 * `drainEmbeddingQueue` each probe once per call, so a single `akm index` or
 * `akm remember` otherwise repeated the same handful of HTTP requests two or
 * three times over. The cached PROMISE is stored (not just its resolved
 * value), so concurrent callers before the first probe settles share the one
 * in-flight request set rather than each starting their own. A probe that
 * falls back to `source: "default"` (network error, malformed response) is
 * cached too: a process is one CLI run, and a flapping endpoint is the
 * drain's own retry/back-off's problem, not this cache's.
 */
const providerLimitsCache = new Map<string, Promise<ProviderLimits>>();

/** TEST-ONLY: clear the per-process probe cache so each test starts from a clean slate. */
export function _resetProviderLimitsCacheForTests(): void {
  providerLimitsCache.clear();
}

/**
 * Probe the configured embedding endpoint for its OWN window/slot limits.
 * Tries llama.cpp's `GET /props` first, then Ollama's `POST /api/show`; an
 * endpoint that answers neither (an OpenAI-compatible server, a gateway),
 * one that answers with an implausibly small window (see
 * {@link isUsableWindow}) — or a config with no remote `endpoint` at all (a
 * local-only embedder) — gets the conservative default. Never throws: any
 * probe failure (a network error, a malformed response, an unparseable
 * endpoint) resolves to the same default shape rather than rejecting.
 *
 * Memoised per process — see {@link providerLimitsCache} — so every caller
 * with the same effective config (`endpoint`/`model`/`concurrency`/
 * `timeoutMs`) shares one probe's HTTP requests instead of repeating them.
 */
export async function probeProviderLimits(
  config: EmbeddingConnectionConfig,
  opts?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<ProviderLimits> {
  const cacheKey = JSON.stringify({
    endpoint: config.endpoint,
    model: config.model,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
  });
  const cached = providerLimitsCache.get(cacheKey);
  if (cached) return cached;

  const probe = probeProviderLimitsUncached(config, opts);
  providerLimitsCache.set(cacheKey, probe);
  return probe;
}

/**
 * Character bound for one embedding unit's text (A1's `deriveUnits`
 * `maxChars` parameter): `windowTokens` minus the header margin, converted
 * to characters via `charsPerToken`. Never negative — a pathologically
 * small window still yields a usable (if tiny) bound rather than a
 * negative `maxChars` that would make every split trivially fail.
 */
export function unitMaxChars(limits: ProviderLimits): number {
  return Math.max(0, Math.floor((limits.windowTokens - UNIT_HEADER_MARGIN_TOKENS) * limits.charsPerToken));
}
