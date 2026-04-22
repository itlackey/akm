import { fetchWithTimeout } from "./common";
import type { LlmConnectionConfig } from "./config";
import type { StashEntry } from "./metadata";

// ── OpenAI-compatible chat completions ──────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

export interface ChatCompletionOptions {
  /** Override the config's max_tokens for this call (used by ingest/lint which need longer outputs). */
  maxTokens?: number;
  /** Override the config's temperature for this call. */
  temperature?: number;
}

export async function chatCompletion(
  config: LlmConnectionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: options?.temperature ?? config.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 512,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as ChatCompletionResponse;
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Strip leading/trailing markdown code fences from an LLM response. */
function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

/** Parse a possibly-fenced JSON response. Returns undefined if invalid. */
export function parseJsonResponse<T = unknown>(raw: string): T | undefined {
  try {
    return JSON.parse(stripJsonFences(raw)) as T;
  } catch {
    return undefined;
  }
}

// ── Metadata Enhancement ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a metadata generator for a developer asset registry. Given a script/skill/command/agent entry, generate improved metadata. Respond with ONLY valid JSON, no markdown fencing.`;

/**
 * Use an LLM to enhance a stash entry's metadata: improve description,
 * generate searchHints, and suggest tags.
 */
export async function enhanceMetadata(
  config: LlmConnectionConfig,
  entry: StashEntry,
  fileContent?: string,
): Promise<{ description?: string; searchHints?: string[]; tags?: string[] }> {
  const contextParts = [`Name: ${entry.name}`, `Type: ${entry.type}`];
  if (entry.description) contextParts.push(`Current description: ${entry.description}`);
  if (entry.tags?.length) contextParts.push(`Current tags: ${entry.tags.join(", ")}`);
  if (fileContent) {
    // Limit content to first 2000 chars to stay within token limits
    const truncated = fileContent.length > 2000 ? `${fileContent.slice(0, 2000)}\n... (truncated)` : fileContent;
    contextParts.push(`File content:\n${truncated}`);
  }

  const userPrompt = `${contextParts.join("\n")}

Generate improved metadata for this ${entry.type}. Return JSON with these fields:
- "description": a clear, concise one-sentence description of what this does
- "searchHints": an array of 3-6 natural language task phrases an agent might use to find this (e.g. "deploy a docker container", "run database migrations")
- "tags": an array of 3-8 relevant keyword tags

Return ONLY the JSON object, no explanation.`;

  const raw = await chatCompletion(config, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);

  const parsed = parseJsonResponse<Record<string, unknown>>(raw);
  if (!parsed) return {};

  const result: { description?: string; searchHints?: string[]; tags?: string[] } = {};

  if (typeof parsed.description === "string" && parsed.description) {
    result.description = parsed.description;
  }
  if (Array.isArray(parsed.searchHints)) {
    result.searchHints = parsed.searchHints
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, 8);
  }
  if (Array.isArray(parsed.tags)) {
    result.tags = parsed.tags.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 10);
  }

  return result;
}

/**
 * Check if the LLM endpoint is reachable.
 */
export async function isLlmAvailable(config: LlmConnectionConfig): Promise<boolean> {
  try {
    const result = await chatCompletion(config, [{ role: "user", content: "Respond with just the word: ok" }]);
    return result.length > 0;
  } catch {
    return false;
  }
}

// ── Capability probe ────────────────────────────────────────────────────────

/**
 * Ask the model to emit a strict JSON object so we know whether the knowledge
 * wiki ingest/lint flows can rely on structured output. Failure is non-fatal —
 * the caller can fall back to assist-only mode.
 */
export async function probeLlmCapabilities(
  config: LlmConnectionConfig,
): Promise<{ reachable: boolean; structuredOutput: boolean; error?: string }> {
  try {
    const raw = await chatCompletion(
      config,
      [
        {
          role: "system",
          content: "You return only valid JSON. No prose, no markdown fences.",
        },
        {
          role: "user",
          content: 'Return exactly this JSON object and nothing else: {"ok": true, "ingest": true, "lint": true}',
        },
      ],
      { maxTokens: 64, temperature: 0 },
    );
    if (!raw) return { reachable: false, structuredOutput: false, error: "empty response" };
    const parsed = parseJsonResponse<{ ok?: unknown }>(raw);
    return {
      reachable: true,
      structuredOutput: Boolean(parsed && parsed.ok === true),
    };
  } catch (err) {
    return { reachable: false, structuredOutput: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Knowledge-wiki ingest / lint prompts ────────────────────────────────────

export interface WikiCandidatePage {
  /** Asset ref, e.g. "knowledge:auth-design". */
  ref: string;
  /** Display name for the LLM. */
  name: string;
  /** Optional description / summary so the LLM can judge relevance without a full read. */
  description?: string;
  /** Optional short excerpt of the page body. */
  excerpt?: string;
}

export interface WikiPageEdit {
  /** Asset ref of an existing page to update, e.g. "knowledge:auth-design". */
  ref: string;
  /** What to add or change, in markdown. The caller decides how to apply. */
  patch: string;
  /** One-line rationale for the edit, used in log.md. */
  reason: string;
}

export interface WikiPageCreate {
  /** Slug for the new page (no extension), e.g. "passkey-rollout-2026". */
  name: string;
  /** Page archetype; defaults to "note" if missing. */
  pageKind?: "entity" | "concept" | "question" | "note";
  /** Markdown body for the new page (frontmatter is added by the caller). */
  body: string;
  /** Other knowledge refs this page links to. Must come from the candidate set. */
  xrefs?: string[];
}

export interface WikiIngestPlan {
  /** Short summary of the source. Used in log.md. */
  summary: string;
  /** New pages to create. */
  newPages: WikiPageCreate[];
  /** Edits to existing pages. */
  edits: WikiPageEdit[];
  /** Free-form note for log.md (e.g. "no relevant existing pages yet"). */
  note?: string;
}

const INGEST_SYSTEM_PROMPT = `You maintain a markdown-based knowledge wiki following Andrej Karpathy's LLM Wiki pattern.
You receive (a) one new immutable raw source and (b) up to ~15 candidate existing pages found by full-text search.
Your job is to decide which pages to update and which new pages to create so the source is fully assimilated.
Hard rules:
- The raw source is immutable. Never propose to edit it.
- Cross-references (xrefs) must come from the candidate set. Do not invent refs.
- Prefer updating an existing page over creating a duplicate.
- Patches are appended to the page (or applied at the end of the relevant section by the caller); write them as additive markdown.
- Respond with ONLY a single JSON object, no prose, no markdown fencing.`;

export async function ingestKnowledgeSource(
  config: LlmConnectionConfig,
  input: {
    sourceName: string;
    sourceContent: string;
    candidates: WikiCandidatePage[];
  },
): Promise<WikiIngestPlan | undefined> {
  const truncatedSource =
    input.sourceContent.length > 8000 ? `${input.sourceContent.slice(0, 8000)}\n... (truncated)` : input.sourceContent;

  const candidateBlock =
    input.candidates.length === 0
      ? "(no related pages exist yet)"
      : input.candidates
          .map((c, i) => {
            const desc = c.description ? `\n  description: ${c.description}` : "";
            const excerpt = c.excerpt ? `\n  excerpt: ${c.excerpt}` : "";
            return `${i + 1}. ${c.ref}${desc}${excerpt}`;
          })
          .join("\n");

  const userPrompt = `New raw source: ${input.sourceName}
---
${truncatedSource}
---

Candidate existing pages (you may xref these by ref):
${candidateBlock}

Return JSON shaped exactly like:
{
  "summary": "one sentence on what the source contributes",
  "newPages": [
    { "name": "slug-here", "pageKind": "entity|concept|question|note", "body": "# Title\\n\\n...markdown...", "xrefs": ["knowledge:other-page"] }
  ],
  "edits": [
    { "ref": "knowledge:existing-page", "patch": "## New section\\n\\n...markdown...", "reason": "captures the X angle from this source" }
  ],
  "note": "optional one-liner for log.md"
}

Rules: every xref must appear in the candidate list. newPages and edits may be empty arrays. Keep patches additive and self-contained.`;

  const raw = await chatCompletion(
    config,
    [
      { role: "system", content: INGEST_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 2048 },
  );

  const parsed = parseJsonResponse<Record<string, unknown>>(raw);
  if (!parsed) return undefined;

  const candidateRefs = new Set(input.candidates.map((c) => c.ref));
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const note = typeof parsed.note === "string" ? parsed.note : undefined;

  const newPages: WikiPageCreate[] = [];
  if (Array.isArray(parsed.newPages)) {
    for (const item of parsed.newPages) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name.trim() : "";
      const body = typeof rec.body === "string" ? rec.body : "";
      if (!name || !body) continue;
      const page: WikiPageCreate = { name, body };
      if (
        rec.pageKind === "entity" ||
        rec.pageKind === "concept" ||
        rec.pageKind === "question" ||
        rec.pageKind === "note"
      ) {
        page.pageKind = rec.pageKind;
      }
      if (Array.isArray(rec.xrefs)) {
        const refs = rec.xrefs.filter((x): x is string => typeof x === "string" && candidateRefs.has(x));
        if (refs.length > 0) page.xrefs = refs;
      }
      newPages.push(page);
    }
  }

  const edits: WikiPageEdit[] = [];
  if (Array.isArray(parsed.edits)) {
    for (const item of parsed.edits) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const ref = typeof rec.ref === "string" ? rec.ref.trim() : "";
      const patch = typeof rec.patch === "string" ? rec.patch : "";
      const reason = typeof rec.reason === "string" ? rec.reason : "";
      if (!ref || !patch || !candidateRefs.has(ref)) continue;
      edits.push({ ref, patch, reason });
    }
  }

  return { summary, newPages, edits, note };
}

export interface WikiLintFinding {
  /** "contradiction", "orphan", "stale", "missing-xref", or other. */
  kind: string;
  /** Page refs the finding relates to. */
  refs: string[];
  /** Human-readable description. */
  message: string;
  /** Optional patch text the caller can apply with --fix. */
  suggestedFix?: string;
}

export interface WikiLintReport {
  findings: WikiLintFinding[];
  /** Optional one-line health summary. */
  summary?: string;
}

const LINT_SYSTEM_PROMPT = `You audit a markdown knowledge wiki. You receive a list of pages with their summaries and xrefs.
Look for:
- contradictions between pages
- orphans (pages with no incoming or outgoing xrefs)
- stale claims (older pages whose claims a newer page contradicts or supersedes)
- missing xrefs (two pages clearly about the same entity/concept but not linked)
Respond with ONLY a single JSON object, no prose, no markdown fencing.`;

export async function lintKnowledge(
  config: LlmConnectionConfig,
  input: { pages: Array<{ ref: string; description?: string; xrefs?: string[]; pageKind?: string }> },
): Promise<WikiLintReport | undefined> {
  const pageBlock = input.pages
    .slice(0, 200)
    .map((p) => {
      const kind = p.pageKind ? ` [${p.pageKind}]` : "";
      const desc = p.description ? ` — ${p.description}` : "";
      const xrefs = p.xrefs && p.xrefs.length > 0 ? ` xrefs=${p.xrefs.join(",")}` : " xrefs=none";
      return `${p.ref}${kind}${desc}${xrefs}`;
    })
    .join("\n");

  const userPrompt = `Pages in the wiki:
${pageBlock}

Return JSON shaped like:
{
  "summary": "one-line health summary",
  "findings": [
    { "kind": "orphan", "refs": ["knowledge:page-a"], "message": "no incoming or outgoing xrefs" }
  ]
}

Findings may be empty when the wiki is healthy.`;

  const raw = await chatCompletion(
    config,
    [
      { role: "system", content: LINT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { maxTokens: 2048 },
  );

  const parsed = parseJsonResponse<Record<string, unknown>>(raw);
  if (!parsed) return undefined;
  const findings: WikiLintFinding[] = [];
  if (Array.isArray(parsed.findings)) {
    for (const item of parsed.findings) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const kind = typeof rec.kind === "string" ? rec.kind : "";
      const message = typeof rec.message === "string" ? rec.message : "";
      const refs = Array.isArray(rec.refs) ? rec.refs.filter((r): r is string => typeof r === "string") : [];
      if (!kind || !message) continue;
      const finding: WikiLintFinding = { kind, refs, message };
      if (typeof rec.suggestedFix === "string" && rec.suggestedFix.trim()) {
        finding.suggestedFix = rec.suggestedFix;
      }
      findings.push(finding);
    }
  }
  return {
    findings,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
  };
}
