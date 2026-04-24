/**
 * Memory-specific helpers for `akm remember`.
 *
 * Extracted from `src/cli.ts` so the domain logic (frontmatter assembly,
 * heuristic derivation, LLM enrichment) is testable in isolation and the
 * CLI entry point stays focused on argument parsing + output routing.
 */

import { stringify as yamlStringify } from "yaml";
import { toErrorMessage, tryReadStdinText } from "./common";
import { loadConfig } from "./config";
import { UsageError } from "./errors";
import { warn } from "./warn";

/**
 * Fields the CLI collects via `--tag`, `--expires`, `--source`, `--auto`,
 * or `--enrich` before writing a memory. All optional; a `tags` array of
 * length 0 is treated the same as absent.
 */
export interface MemoryFrontmatterFields {
  description?: string;
  tags?: string[];
  source?: string;
  observed_at?: string;
  expires?: string;
  subjective?: boolean;
}

/**
 * Parse a shorthand duration string to a number of milliseconds.
 * Supports: `30d` (days), `12h` (hours), `6m` (months, approximated as 30d).
 */
export function parseDuration(s: string): number {
  const match = s.trim().match(/^(\d+)([dhm])$/i);
  if (!match) throw new UsageError(`Invalid --expires format "${s}". Use shorthand like 30d, 12h, or 6m.`);
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
  // 'm' = months, approximated as 30 days
  return n * 30 * 24 * 60 * 60 * 1000;
}

/**
 * Build a YAML frontmatter block from memory metadata.
 *
 * Uses `yaml.stringify` so values containing newlines, colons, or other
 * YAML metacharacters are safely quoted. The previous implementation
 * interpolated user input directly into `key: value` lines, which let a
 * `description` containing `\n` + `tags: [x]` inject additional keys into
 * the frontmatter — that is no longer possible here.
 *
 * Only includes fields that are present (non-empty).
 */
export function buildMemoryFrontmatter(fields: MemoryFrontmatterFields): string {
  const obj: Record<string, unknown> = {};
  if (fields.description && fields.description.trim()) obj.description = fields.description;
  if (fields.tags && fields.tags.length > 0) obj.tags = fields.tags;
  if (fields.source && fields.source.trim()) obj.source = fields.source;
  if (fields.observed_at && fields.observed_at.trim()) obj.observed_at = fields.observed_at;
  if (fields.expires && fields.expires.trim()) obj.expires = fields.expires;
  if (fields.subjective) obj.subjective = true;
  // No fields populated → emit a bare delimiter pair so callers don't
  // produce `---\n{}\n---` (the YAML serializer's empty-object form).
  if (Object.keys(obj).length === 0) return "---\n---";
  const serialized = yamlStringify(obj).trimEnd();
  return `---\n${serialized}\n---`;
}

/**
 * Read memory content from the positional arg or stdin.
 * Throws {@link UsageError} if neither is populated.
 */
export function readMemoryContent(contentArg: string | undefined): string {
  const content = contentArg ?? tryReadStdinText();
  if (!content?.trim()) {
    throw new UsageError("Memory content is required. Pass quoted text or pipe markdown into stdin.");
  }
  return content;
}

/**
 * Result of running `--auto` heuristics on a memory body.
 *
 * `tags` is always an array (possibly empty) so callers can accumulate
 * without null-checks. The caller is responsible for giving CLI-supplied
 * values precedence over heuristic-derived ones.
 */
export interface HeuristicResult {
  tags: string[];
  source?: string;
  observed_at?: string;
  subjective?: boolean;
}

/**
 * Run heuristic analysis on memory body text. Returns derived metadata
 * fields without modifying any files. Pure TS, zero network, zero latency.
 */
export function runAutoHeuristics(body: string): HeuristicResult {
  const tags: string[] = [];

  // Fenced code block present → tag "code"
  if (/^```/m.test(body)) {
    tags.push("code");
  }

  // First-person pronoun → subjective
  const subjective = /\b(I|we|my|our)\b/.test(body) ? true : undefined;

  // First URL-shaped token → source
  const urlMatch = body.match(/https?:\/\/[^\s)>'"]+/);
  const source = urlMatch ? urlMatch[0] : undefined;

  // ISO date token or obvious relative date phrase → observed_at
  const observed_at = detectObservedAt(body);

  return { tags, source, observed_at, subjective };
}

const RELATIVE_DATE_OFFSETS: Record<string, (d: Date) => void> = {
  today: () => {},
  yesterday: (d) => d.setDate(d.getDate() - 1),
  "last week": (d) => d.setDate(d.getDate() - 7),
  "last month": (d) => d.setMonth(d.getMonth() - 1),
};

function detectObservedAt(body: string): string | undefined {
  const isoMatch = body.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const relMatch = body.match(/\b(today|yesterday|last\s+week|last\s+month)\b/i);
  if (!relMatch) return undefined;

  // Normalise the matched phrase: lowercase, collapse internal whitespace,
  // so "last  week" matches the lookup table key.
  const phrase = relMatch[1].toLowerCase().replace(/\s+/g, " ");
  const offset = RELATIVE_DATE_OFFSETS[phrase];
  if (!offset) return undefined;

  const d = new Date();
  offset(d);
  return d.toISOString().slice(0, 10);
}

/**
 * Result of an `--enrich` LLM call.
 *
 * `tags` is always an array (possibly empty). `description` and
 * `observed_at` are optional — only populated when the model returns them
 * in the expected shape. On any failure (LLM not configured, timeout,
 * invalid JSON), the result is `{ tags: [] }` and a warning was emitted.
 */
export interface EnrichmentResult {
  tags: string[];
  description?: string;
  observed_at?: string;
}

/** Hard timeout for the `--enrich` LLM call. Write-path must not block on a misbehaving endpoint. */
const LLM_ENRICH_TIMEOUT_MS = 10_000;

/**
 * Attempt LLM enrichment of memory metadata. Returns merged metadata
 * fields on success. On timeout, unreachable, or invalid JSON — returns
 * empty result and emits a warning. Never throws; always resolves.
 */
export async function runLlmEnrich(body: string): Promise<EnrichmentResult> {
  const config = loadConfig();
  if (!config.llm) {
    warn("Warning: --enrich requires an LLM to be configured. Run `akm config set llm` to configure one.");
    return { tags: [] };
  }

  const { chatCompletion, parseJsonResponse } = await import("./llm.js");

  const prompt = `You are a memory tagger for a developer knowledge base.
Given the memory text below, return ONLY a JSON object with these fields:
- "tags": array of 1-5 short lowercase keyword tags
- "description": one-sentence summary (optional)
- "observed_at": ISO date (YYYY-MM-DD) if the text references a specific date (optional)

Memory text:
${body.slice(0, 2000)}

Return ONLY the JSON object, no prose, no markdown fences.`;

  try {
    const result = await Promise.race([
      chatCompletion(
        config.llm,
        [
          { role: "system", content: "Return only valid JSON. No prose." },
          { role: "user", content: prompt },
        ],
        { maxTokens: 256, temperature: 0.1 },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM enrichment timed out")), LLM_ENRICH_TIMEOUT_MS),
      ),
    ]);

    const parsed = parseJsonResponse<Record<string, unknown>>(result);
    if (!parsed) {
      warn("Warning: --enrich received invalid JSON from the LLM. Writing memory without enrichment.");
      return { tags: [] };
    }

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : [];

    const description =
      typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : undefined;

    const observed_at =
      typeof parsed.observed_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.observed_at.trim())
        ? parsed.observed_at.trim()
        : undefined;

    return { tags, description, observed_at };
  } catch (err) {
    warn(`Warning: --enrich failed (${toErrorMessage(err)}). Writing memory without enrichment.`);
    return { tags: [] };
  }
}
