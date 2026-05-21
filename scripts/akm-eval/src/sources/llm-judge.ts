/**
 * Phase 7: optional LLM judge.
 *
 * Posts a fixed system prompt + the case-supplied rubric + artifact to an
 * OpenAI-compatible chat-completions endpoint and parses a JSON verdict
 * with `score`, `band`, and `rationale`. Records prompt and artifact
 * hashes for replay/audit.
 *
 * Design rules:
 *   - All errors are non-fatal: the function returns a partial result
 *     with `error` populated instead of throwing. The deterministic eval
 *     path must never fail because the judge is down.
 *   - Bun's built-in `fetch` only — no new npm deps.
 *   - The judge's score is NEVER folded into deterministic aggregation
 *     (the orchestrator stores it on `EvalCaseResult.llmJudgement`).
 *   - API keys are never logged (we use a redacted preview for diagnostic
 *     messages).
 *   - The MT-Bench (arXiv:2306.05685) variance argument is why judge
 *     scores must remain a separate audit signal.
 *
 * No imports from akm's `src/` — the toolkit shells out to akm and uses
 * its own OpenAI-compatible HTTP client.
 */

import type { LlmJudgeContext, LlmJudgementResult } from "../types";

/** Max rubric length permitted (4 KB). Rubric is never truncated; we throw. */
export const MAX_RUBRIC_BYTES = 4 * 1024;
/** Default max artifact length (16 KB). Overridable via `req.maxArtifactBytes`. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024;
/** Default request timeout (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Default judge model when not otherwise configured. */
export const DEFAULT_JUDGE_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = [
  "You are an evaluator. You read a rubric and an artifact and return",
  "STRICT JSON with three fields: `score` (number in [0,1]), `band`",
  "(one of \"low\", \"medium\", \"high\"), and `rationale` (one-paragraph",
  "string explaining the score).",
  "Be conservative: when in doubt, lower the score and the band.",
  "Return ONLY the JSON object — no prose, no Markdown fences.",
].join("\n");

export interface JudgeRequest {
  /** Free-text artifact being judged. May be truncated server-side. */
  artifact: string;
  /** Free-text grading rubric/instructions. Capped at 4 KB. */
  rubric: string;
  /** Optional override for the artifact byte cap. */
  maxArtifactBytes?: number;
  /** Optional addition to the system prompt. */
  systemSuffix?: string;
}

export type JudgeResponse = LlmJudgementResult;

interface ProviderDefaults {
  /** Base URL (no trailing slash) for the OpenAI-compatible endpoint. */
  baseUrl: string;
  /** Env var name where the API key conventionally lives. */
  apiKeyEnv: string;
}

/**
 * Best-effort defaults for common OpenAI-compatible providers. Falls
 * back to OpenAI if the provider name is unknown.
 */
export function providerDefaults(provider: string): ProviderDefaults {
  const p = provider.toLowerCase();
  switch (p) {
    case "openai":
      return { baseUrl: "https://api.openai.com", apiKeyEnv: "OPENAI_API_KEY" };
    case "openrouter":
      return { baseUrl: "https://openrouter.ai/api", apiKeyEnv: "OPENROUTER_API_KEY" };
    case "ollama":
      return { baseUrl: "http://localhost:11434", apiKeyEnv: "OLLAMA_API_KEY" };
    case "llamacpp":
    case "llama.cpp":
    case "llamafile":
      return { baseUrl: "http://localhost:8080", apiKeyEnv: "LLAMACPP_API_KEY" };
    case "lmstudio":
      return { baseUrl: "http://localhost:1234", apiKeyEnv: "LMSTUDIO_API_KEY" };
    default:
      return { baseUrl: "https://api.openai.com", apiKeyEnv: "OPENAI_API_KEY" };
  }
}

/** Build the rendered user-prompt (rubric + artifact). Bytewise capped. */
export function renderJudgePrompt(req: JudgeRequest): { user: string; artifactUsed: string } {
  const maxArtifact = Math.max(256, req.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES);
  const artifactBytes = byteLength(req.artifact);
  const artifactUsed =
    artifactBytes <= maxArtifact ? req.artifact : truncateByBytes(req.artifact, maxArtifact);
  const truncatedNote =
    artifactBytes <= maxArtifact
      ? ""
      : `\n\n[note: artifact truncated from ${artifactBytes} to ~${maxArtifact} bytes]`;
  const user = [
    "RUBRIC:",
    req.rubric,
    "",
    "ARTIFACT:",
    artifactUsed,
    truncatedNote,
    "",
    'Return JSON of shape {"score":<0..1>,"band":"low|medium|high","rationale":"..."}.',
  ].join("\n");
  return { user, artifactUsed };
}

/** SHA-256 hex digest using Bun's WebCrypto. */
async function sha256Hex(s: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function truncateByBytes(s: string, max: number): string {
  const enc = new TextEncoder().encode(s);
  if (enc.length <= max) return s;
  return new TextDecoder("utf-8", { fatal: false }).decode(enc.slice(0, max));
}

/**
 * Tighten a free-text response into something JSON-parseable. Strips
 * Markdown fences and grabs the first balanced `{...}` block.
 */
function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  // Find the first {...} balanced run.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}

interface ParsedVerdict {
  score: number;
  band: "low" | "medium" | "high";
  rationale: string;
}

function parseVerdict(raw: string): ParsedVerdict | null {
  // First: direct JSON.
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    const block = extractJsonBlock(raw);
    if (!block) return null;
    try {
      obj = JSON.parse(block);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const score = typeof o.score === "number" ? o.score : Number(o.score);
  if (!Number.isFinite(score)) return null;
  const clampedScore = Math.min(1, Math.max(0, score));
  const bandRaw = typeof o.band === "string" ? o.band.toLowerCase() : "";
  const band: ParsedVerdict["band"] =
    bandRaw === "low" || bandRaw === "medium" || bandRaw === "high" ? bandRaw : "low";
  const rationale = typeof o.rationale === "string" ? o.rationale : "";
  return { score: clampedScore, band, rationale };
}

interface ChatCompletionBody {
  model: string;
  temperature: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
  response_format?: { type: "json_object" };
}

interface RawChatChoice {
  message?: { content?: string | null };
}

interface RawChatResponse {
  choices?: RawChatChoice[];
}

async function postChat(
  ctx: LlmJudgeContext,
  baseUrl: string,
  body: ChatCompletionBody,
  timeoutMs: number,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await safeText(res);
      return { ok: false, error: `http ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as RawChatResponse;
    const content = json.choices?.[0]?.message?.content ?? "";
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: "empty completion content" };
    }
    return { ok: true, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Call the LLM judge for a single rubric + artifact. Returns `null` only
 * when the rubric exceeds its hard cap (programmer error). All other
 * failures populate `error` on the returned `JudgeResponse` and leave
 * `score = 0` / `band = "low"`. Callers should treat that the same as
 * "judge unavailable" — never as a deterministic gate failure.
 */
export async function llmJudge(
  ctx: LlmJudgeContext,
  req: JudgeRequest,
): Promise<JudgeResponse | null> {
  if (!ctx.enabled) return null;

  if (byteLength(req.rubric) > MAX_RUBRIC_BYTES) {
    // Hard rubric cap: throw so the case author fixes the case.
    // Truncating the rubric would silently change the grading instructions;
    // returning null would let callers ignore the cap (which is exactly
    // what the "silent degradation refused" contract says not to do).
    throw new Error(
      `llmJudge: rubric exceeds ${MAX_RUBRIC_BYTES} bytes (got ${byteLength(req.rubric)}). Shorten the rubric in the case file.`,
    );
  }

  const startedAt = new Date();
  const start = performance.now();
  const defaults = providerDefaults(ctx.provider);
  const baseUrl = ctx.endpoint && ctx.endpoint.trim() ? ctx.endpoint.trim() : defaults.baseUrl;

  const { user, artifactUsed } = renderJudgePrompt(req);
  const systemPrompt = req.systemSuffix ? `${SYSTEM_PROMPT}\n\n${req.systemSuffix}` : SYSTEM_PROMPT;
  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: user },
  ];
  const renderedForHash = `${systemPrompt}\n---\n${user}`;
  const [promptHash, artifactHash] = await Promise.all([
    sha256Hex(renderedForHash),
    sha256Hex(artifactUsed),
  ]);

  const body: ChatCompletionBody = {
    model: ctx.model,
    temperature: ctx.temperature,
    messages,
    response_format: { type: "json_object" },
  };

  const first = await postChat(ctx, baseUrl, body, DEFAULT_TIMEOUT_MS);
  let rawContent: string;
  let lastError: string | undefined;
  if (first.ok) {
    rawContent = first.content;
  } else {
    lastError = first.error;
    rawContent = "";
  }

  let verdict = first.ok ? parseVerdict(first.content) : null;

  // Single repair pass on parse failure: re-ask for strict JSON.
  if (first.ok && !verdict) {
    const repairBody: ChatCompletionBody = {
      model: ctx.model,
      temperature: 0,
      messages: [
        ...messages,
        {
          role: "user" as const,
          content:
            "Your previous response was not valid JSON. Reply with the JSON object only, no prose.",
        },
      ],
      response_format: { type: "json_object" },
    };
    const second = await postChat(ctx, baseUrl, repairBody, DEFAULT_TIMEOUT_MS);
    if (second.ok) {
      rawContent = second.content;
      verdict = parseVerdict(second.content);
      if (!verdict) lastError = "judge returned non-JSON after repair";
    } else {
      lastError = second.error;
    }
  }

  const durationMs = Math.round(performance.now() - start);
  const provenance = {
    model: ctx.model,
    provider: ctx.provider,
    temperature: ctx.temperature,
    promptHash,
    artifactHash,
    durationMs,
    ts: startedAt.toISOString(),
  } as const;

  if (verdict) {
    return {
      score: verdict.score,
      band: verdict.band,
      rationale: verdict.rationale,
      provenance,
    };
  }

  // Non-fatal: return a placeholder result with `error` set.
  return {
    score: 0,
    band: "low",
    rationale: rawContent ? `<<unparsed>> ${rawContent.slice(0, 256)}` : "",
    provenance,
    error: lastError ?? "judge call failed",
  };
}

/**
 * Resolve the API key for a judge context from a process env. Returns
 * `undefined` for "no key found" — caller decides whether to fail.
 */
export function resolveJudgeApiKey(
  provider: string,
  env: Record<string, string | undefined>,
): string | undefined {
  // Most specific first: explicit AKM_EVAL override.
  const explicit = env.AKM_EVAL_JUDGE_API_KEY;
  if (explicit && explicit.trim()) return explicit.trim();
  const defaults = providerDefaults(provider);
  const fromProvider = env[defaults.apiKeyEnv];
  if (fromProvider && fromProvider.trim()) return fromProvider.trim();
  return undefined;
}

/**
 * Resolve the endpoint URL for a judge context from env. Returns
 * `undefined` to mean "use the provider default".
 */
export function resolveJudgeEndpoint(env: Record<string, string | undefined>): string | undefined {
  const ep = env.AKM_EVAL_JUDGE_ENDPOINT;
  if (ep && ep.trim()) return ep.trim();
  return undefined;
}
