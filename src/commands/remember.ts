// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Memory-specific helpers for `akm remember`.
 *
 * Extracted from `src/cli.ts` so the domain logic (frontmatter assembly,
 * heuristic derivation, LLM enrichment) is testable in isolation and the
 * CLI entry point stays focused on argument parsing + output routing.
 */

import { serializeFrontmatter } from "../core/asset/asset-serialize";
import { DESCRIPTION_MAX_CHARS } from "../core/authoring-rules";
import { toErrorMessage, tryReadStdinText } from "../core/common";
import { loadConfig } from "../core/config/config";
import { ConfigError, UsageError } from "../core/errors";
import { parseEmbeddedJsonResponse } from "../core/parse";
import { DURATION_UNITS, parseDuration as parseDurationSpec } from "../core/time";
import { warn } from "../core/warn";
import type { LoweringNotice } from "../execution/resolved-request";
import type { StashEntryScope } from "../indexer/passes/metadata";
import { SCOPE_KEYS } from "../indexer/passes/metadata";
import { callStructured } from "../llm/structured-call";
import { withLlmStage } from "../llm/usage-telemetry";
import { resolveImproveLlmExecution } from "./improve/execution";

/**
 * Fields the CLI collects via `--tag`, `--expires`, `--source`, `--auto`,
 * `--enrich`, or the scope flags (`--user`, `--agent`, `--run`, `--channel`)
 * before writing a memory. All optional; a `tags` array of length 0 is
 * treated the same as absent.
 *
 * The `scope` shape is the wire-level contract — it is persisted as the
 * canonical top-level frontmatter keys `scope_user`, `scope_agent`,
 * `scope_run`, `scope_channel` (one key per non-empty scope value).
 * Memories without scope continue to load and parse cleanly.
 */
export interface MemoryFrontmatterFields {
  description?: string;
  tags?: string[];
  source?: string;
  /**
   * Cross-reference refs (`[bundle//]conceptId`) collected via `--xref` (repeatable).
   * Persisted as the `xrefs:` frontmatter list — the channel the stash
   * back-linking conventions mandate for provenance/associative links; the
   * indexer folds these into the asset's search hints. An empty array is
   * treated the same as absent.
   */
  xrefs?: string[];
  observed_at?: string;
  expires?: string;
  subjective?: boolean;
  scope?: StashEntryScope;
  /**
   * Capture-mode marker (Phase 1B / Rec 7). `hot` marks memories written via
   * the `akm remember` CLI; `background` is reserved for derived/inferred
   * memories. Persisted as the `captureMode:` frontmatter key.
   */
  captureMode?: "hot" | "background";
  /**
   * Belief state marker (Phase 1B). Hot-path memories are written as
   * `asserted`; the value is persisted verbatim into the `beliefState:`
   * frontmatter key for downstream consumers. Phase 1A widens the indexer's
   * union; until then, the indexer simply passes the string through.
   */
  beliefState?: string;
}

/**
 * Parse a shorthand duration string to a number of milliseconds.
 * Supports the CLI-wide canonical grammar: `30d` (days), `12h` (hours),
 * `5m` (minutes), `3M` (months, approximated as 30d).
 */
export function parseDuration(s: string): number {
  // Canonical CLI unit grammar: `m` = minutes, `M` = months. Not lower-cased,
  // so case distinguishes the two (`5m` = 5 minutes, `5M` = 5 months). See
  // core/time.ts DURATION_UNITS.
  const ms = parseDurationSpec(s.trim(), DURATION_UNITS);
  if (ms === null) {
    throw new UsageError(
      `Invalid --expires format "${s}". Use shorthand like 30d, 12h, 5m, or 3M.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return ms;
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
  if (fields.description?.trim()) obj.description = fields.description;
  if (fields.tags && fields.tags.length > 0) obj.tags = fields.tags;
  if (fields.source?.trim()) obj.source = fields.source;
  if (fields.xrefs && fields.xrefs.length > 0) obj.xrefs = fields.xrefs;
  if (fields.observed_at?.trim()) obj.observed_at = fields.observed_at;
  if (fields.expires?.trim()) obj.expires = fields.expires;
  if (fields.subjective) obj.subjective = true;
  if (fields.captureMode === "hot" || fields.captureMode === "background") {
    obj.captureMode = fields.captureMode;
  }
  if (typeof fields.beliefState === "string" && fields.beliefState.trim()) {
    obj.beliefState = fields.beliefState.trim();
  }
  // Scope keys are emitted as flat top-level keys (`scope_user`, …) so the
  // existing one-level frontmatter parser can read them without nesting.
  // A scope object with no populated values is dropped.
  if (fields.scope) {
    for (const key of SCOPE_KEYS) {
      const value = fields.scope[key];
      if (typeof value === "string" && value.trim()) {
        obj[`scope_${key}`] = value.trim();
      }
    }
  }
  // No fields populated → emit a bare delimiter pair so callers don't
  // produce `---\n{}\n---` (the YAML serializer's empty-object form).
  if (Object.keys(obj).length === 0) return "---\n---";
  const serialized = serializeFrontmatter(obj);
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
 * Split `text` into sentence-shaped chunks on `.`/`!`/`?`, swallowing any
 * immediately-trailing closing quotes/brackets/repeated terminators into the
 * same sentence (so `Alice said, "hi there."` ends the sentence at the
 * closing quote, not the period). A terminator ends a sentence only when
 * whitespace or the end of the text follows, so `192.168.0.203`, `0.9.12`,
 * `example.com` and `notes.md` stay whole.
 *
 * Ported from akm-eval's memory backend (`splitIntoSentences` /
 * `firstSentencesCapped` in akm-eval/src/memory/backends/akm.ts), which
 * independently arrived at this exact synthesis rule after measuring that
 * akm indexes only frontmatter/heading text, never body prose — the same gap
 * this fixes at the source.
 */
function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "." || ch === "!" || ch === "?") {
      let end = i + 1;
      while (end < text.length && /["'”’)\]!?.]/.test(text.charAt(end))) end += 1;
      if (end < text.length && !/\s/.test(text.charAt(end))) {
        i = end;
        continue;
      }
      sentences.push(text.slice(start, end));
      while (end < text.length && /\s/.test(text.charAt(end))) end += 1;
      start = end;
      i = end;
      continue;
    }
    i += 1;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

/**
 * Deterministically synthesize a `description` from a memory body when the
 * caller didn't supply one (#834): `akm remember`'s hot-capture path used to
 * write memories with no `description:` and no `tags:`, and akm's indexer
 * covers only synthesized frontmatter/headings — never body prose — so those
 * memories were retrievable only by whatever words survived into the
 * auto-generated filename. This closes that gap at write time.
 *
 * Skips a leading markdown heading line (if any) so the description reads as
 * prose rather than repeating the title, then accumulates whole sentences
 * from the body until the next one would exceed `capChars`, hard-truncating
 * only if the very first sentence alone is over the cap. Pure, deterministic,
 * no LLM call — `akm remember` must stay a fast local write.
 */
export function synthesizeMemoryDescription(body: string, capChars = DESCRIPTION_MAX_CHARS): string {
  const withoutHeading = body.replace(/^\s*#{1,6}\s+.*(?:\r?\n)?/, "");
  const trimmed = withoutHeading.trim() || body.trim();
  if (!trimmed) return "";
  let out = "";
  for (const raw of splitIntoSentences(trimmed)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const candidate = out ? `${out} ${sentence}` : sentence;
    if (candidate.length > capChars) {
      if (!out) return `${candidate.slice(0, Math.max(0, capChars - 1)).trimEnd()}…`;
      break;
    }
    out = candidate;
  }
  return out;
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
  const phrase = relMatch[1]!.toLowerCase().replace(/\s+/g, " ");
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
 * in the expected shape. An absent engine, provider failure, timeout, or
 * invalid JSON yields `{ tags: [] }` with a warning. Invalid configuration is
 * a hard pre-write error.
 */
export interface EnrichmentResult {
  tags: string[];
  description?: string;
  observed_at?: string;
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
}

/** Hard timeout for the `--enrich` LLM call. Write-path must not block on a misbehaving endpoint. */
const LLM_ENRICH_TIMEOUT_MS = 10_000;

/**
 * Attempt LLM enrichment of memory metadata. Returns merged metadata
 * fields on success. Provider, timeout, and parse failures return an empty
 * result and emit a warning. Invalid configuration remains a hard pre-write
 * error and preserves its original {@link ConfigError}.
 */
export async function runLlmEnrich(body: string): Promise<EnrichmentResult> {
  const config = loadConfig();
  const resolved = resolveImproveLlmExecution({ config, processName: "remember-enrich" });
  if (!resolved) {
    warn("Warning: --enrich requires an LLM to be configured. Run `akm setup` to configure one.");
    return { tags: [] };
  }
  const runner = resolved.runner;
  const noticesByKey = new Map(resolved.notices.map((notice) => [JSON.stringify(notice), notice]));
  const noticeFields = (): { notices?: readonly Readonly<LoweringNotice>[] } =>
    noticesByKey.size > 0 ? { notices: Object.freeze([...noticesByKey.values()]) } : {};

  const prompt = `You are a memory tagger for a developer knowledge base.
Given the memory text below, return ONLY a JSON object with these fields:
- "tags": array of 1-5 short lowercase keyword tags
- "description": one-sentence summary (optional)
- "observed_at": ISO date (YYYY-MM-DD) if the text references a specific date (optional)

Memory text:
${body.slice(0, 2000)}

Return ONLY the JSON object, no prose, no markdown fences.`;

  try {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const result = await (async () => {
      try {
        return await Promise.race([
          withLlmStage("remember", () =>
            callStructured<string>({
              feature: "remember_enrich",
              runner,
              messages: [
                { role: "system", content: "Return only valid JSON. No prose." },
                { role: "user", content: prompt },
              ],
              request: { maxTokens: 256, temperature: 0.1 },
              onNotices: (value) => {
                for (const notice of value) noticesByKey.set(JSON.stringify(notice), notice);
              },
              parse: (raw) => raw ?? "",
              onError: () => "",
              fallback: "",
            }),
          ),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("LLM enrichment timed out")), LLM_ENRICH_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      }
    })();

    const parsed = parseEmbeddedJsonResponse<Record<string, unknown>>(result);
    if (!parsed) {
      warn("Warning: --enrich received invalid JSON from the LLM. Writing memory without enrichment.");
      return { tags: [], ...noticeFields() };
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

    return { tags, description, observed_at, ...noticeFields() };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    warn(`Warning: --enrich failed (${toErrorMessage(err)}). Writing memory without enrichment.`);
    return { tags: [], ...noticeFields() };
  }
}

// R-061(c): `resolveRememberContentArg` / `wasRememberFlagValueConsumedAsContent`
// used to live here — a heuristic guarding against citty consuming a global
// flag's value (`--format`/`--detail`) as the `content` positional. That guard
// predated `rememberCommand` declaring `GLOBAL_OUTPUT_ARGS` (via
// `defineJsonCommand`): once the leaf command itself declares `format`/
// `detail` args, citty's parser consumes their space-separated values as the
// flag's own value and never assigns them to `content` in the first place, so
// the heuristic no longer has anything to guard against. Verified: `akm
// remember "yaml" --format yaml` and `akm remember "brief" --detail brief`
// both write the literal content unchanged. Deleted rather than kept as
// defense-in-depth per the cleanup program's dead-code policy.
