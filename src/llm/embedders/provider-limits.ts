// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The embedding provider's OWN limits — real context window and in-flight
 * slot count — read from the endpoint itself rather than guessed from
 * config (docs/plans/index-fragment-vectors.md, rule 3: "The limits are the
 * provider's"). Two shapes are recognised: llama.cpp's `GET /props`
 * (window, slots), with `/tokenize` when present giving exact token
 * counts; and Ollama's `POST /api/show` (window only — `num_parallel` is
 * not exposed, so slots is always 1 unless `config.concurrency` overrides
 * it). Any other endpoint (an OpenAI-compatible server, a gateway such as
 * Bifrost) reports neither, so a conservative default stands in.
 *
 * `probeProviderLimits` never throws: a probe that fails for any reason
 * (unreachable endpoint, malformed response, a provider that reports
 * nothing recognisable) resolves to the same `source: "default"` shape a
 * misconfigured or exotic endpoint would get.
 *
 * This module is purely additive at this stage: nothing here is wired into
 * the embedding loop yet, and no `embedding.*` config key is touched or
 * removed — that wiring (and removing `maxInputTokens`/`maxTokens`/
 * `batchSize`/`contextLength`) is stage 2.
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
  /** Exact token count via the provider's own tokenizer, when it exposes one (llama.cpp's `/tokenize`). */
  countTokens?: (text: string) => Promise<number>;
  /**
   * Chars-per-token ratio used to turn `windowTokens` into a character
   * bound ({@link unitMaxChars}). Calibrated against this provider/model
   * when `countTokens` exists (see {@link calibrateCharsPerToken}); the
   * fixed {@link CHARS_PER_TOKEN_TAIL} fallback otherwise.
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
 * Number of synthetic texts `probeProviderLimits` tokenizes to calibrate
 * `charsPerToken` (see {@link calibrateCharsPerToken}) when the provider
 * exposes `/tokenize`, per this contract's calibration sample size. The
 * real per-entry unit corpus does not exist yet at probe time — probing
 * runs once, before A1's `deriveUnits` has produced anything — so
 * calibration spans a fixed set of representative text shapes instead.
 */
const CALIBRATION_SAMPLE_COUNT = 64;

/**
 * Percentile (of chars-per-token ratios, sorted ascending) calibration
 * reports: the single densest sampled text, i.e. the smallest
 * chars-per-token ratio — the same conservative, worst-case-density intent
 * the {@link CHARS_PER_TOKEN_TAIL} fallback encodes as a fixed p99.
 */
const CALIBRATION_PERCENTILE = 0.01;

/** Content posted to `/tokenize` purely to check the route exists, before spending the full calibration corpus on it. */
const TOKENIZE_PRESENCE_PROBE_TEXT = "ping";

/**
 * Representative text shapes to calibrate a provider's chars-per-token
 * ratio against. Mirrors the mix real markdown fragments produce — prose,
 * code, a table, a list, a link, non-Latin text (which tokenizes at a very
 * different ratio than English prose), SQL, and dense technical prose —
 * cycled to reach {@link CALIBRATION_SAMPLE_COUNT} samples.
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

/** Build the {@link CALIBRATION_SAMPLE_COUNT}-text calibration corpus by cycling {@link CALIBRATION_SHAPES}. */
function buildCalibrationCorpus(): string[] {
  const corpus: string[] = [];
  for (let i = 0; i < CALIBRATION_SAMPLE_COUNT; i++) {
    const shape = CALIBRATION_SHAPES[i % CALIBRATION_SHAPES.length] as string;
    // Vary repeated shapes slightly so they do not all collapse to the exact
    // same chars-per-token ratio once the corpus wraps past CALIBRATION_SHAPES.length.
    corpus.push(i < CALIBRATION_SHAPES.length ? shape : `${shape} (sample ${i})`);
  }
  return corpus;
}

/** Index into a `length`-element array, sorted ascending, at `percentile` (0-1). Clamped so a tiny array still yields a valid index. */
function percentileIndex(length: number, percentile: number): number {
  if (length <= 1) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor((length - 1) * percentile)));
}

/**
 * Calibrate `charsPerToken` against a real provider/model by tokenizing the
 * built-in calibration corpus and taking the {@link CALIBRATION_PERCENTILE}
 * (densest-text) chars-per-token ratio across it. A sample whose tokenize
 * call fails is skipped rather than aborting the whole calibration; only a
 * total wipeout (every sample failed) falls back to {@link CHARS_PER_TOKEN_TAIL}.
 */
async function calibrateCharsPerToken(countTokens: (text: string) => Promise<number>): Promise<number> {
  const ratios: number[] = [];
  for (const text of buildCalibrationCorpus()) {
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

  return { windowTokens, slots, source: "llama.cpp", countTokens, charsPerToken };
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
 * Probe the configured embedding endpoint for its OWN window/slot limits.
 * Tries llama.cpp's `GET /props` first, then Ollama's `POST /api/show`; an
 * endpoint that answers neither (an OpenAI-compatible server, a gateway) —
 * or a config with no remote `endpoint` at all (a local-only embedder) —
 * gets the conservative default. Never throws: any probe failure (a
 * network error, a malformed response, an unparseable endpoint) resolves
 * to the same default shape rather than rejecting.
 */
export async function probeProviderLimits(
  config: EmbeddingConnectionConfig,
  opts?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<ProviderLimits> {
  const origin = resolveOrigin(config.endpoint);
  if (!origin) return defaultLimits(config);

  const fetchImpl = opts?.fetch ?? fetch;
  const timeoutMs = resolveProbeTimeoutMs(config);
  const signal = opts?.signal;

  const llamaCpp = await probeLlamaCpp(origin, config, fetchImpl, timeoutMs, signal).catch(() => undefined);
  if (llamaCpp) return llamaCpp;

  const ollama = await probeOllama(origin, config, fetchImpl, timeoutMs, signal).catch(() => undefined);
  if (ollama) return ollama;

  return defaultLimits(config);
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
