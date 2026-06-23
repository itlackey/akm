// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared prompt builders for proposal-producing agent commands (#226).
 *
 * `akm reflect` and `akm propose` both shell out to the configured agent CLI
 * (via {@link runAgent}) and ask it for a structured proposal payload. The
 * prompts are intentionally similar — both ask the agent to return a single
 * JSON object containing `ref`, `content`, and (optionally) `frontmatter` —
 * so we share the construction here. Keeping the prompt builders in
 * `src/integrations/agent/` rather than `src/llm/` is deliberate: these are
 * shell-out prompts targeting an agent CLI, not in-tree LLM API calls.
 *
 * The output the agent must produce is a *strict* JSON object:
 *
 * ```json
 * {
 *   "ref": "lesson:my-lesson",
 *   "content": "---\ndescription: ...\nwhen_to_use: ...\n---\n\nbody",
 *   "frontmatter": { "description": "...", "when_to_use": "..." }
 * }
 * ```
 *
 * `frontmatter` is optional — the proposal queue parses it from `content`
 * during validation. We carry it through if the agent supplies it.
 */

import { TYPE_DIRS } from "../../core/asset/asset-spec";
import {
  authoringRulesForType,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_MIN_CHARS,
  requiresDescription,
} from "../../core/authoring-rules";
import { parseEmbeddedJsonResponse, stripCodeFences, stripThinkBlocks } from "../../core/parse";

/** Agent-returned proposal payload (after JSON parse). */
export interface AgentProposalPayload {
  ref: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  /**
   * Optional self-reported confidence score in `[0, 1]` (Advantage D6a / Phase
   * 6A). When provided by the agent (or LLM via structured output) and at or
   * above the active threshold, `akm improve` may auto-accept the proposal
   * without reviewer intervention. Out-of-range / non-finite values are
   * clamped or dropped downstream in `createProposal`.
   */
  confidence?: number;
}

/**
 * Per-asset-type frontmatter / authoring hints surfaced in the prompt so
 * the agent can produce content that passes proposal validation. Kept tiny:
 * full schema docs live in `docs/` — these are nudges, not contracts.
 */
const TYPE_HINTS: Record<string, string> = {
  lesson:
    "lesson assets MUST start with frontmatter containing `description` and `when_to_use` keys (both non-empty). Body: 1–3 short paragraphs of practical guidance. A lesson is NOT a restatement of the source asset — it answers: When should I reach for this? What goes wrong without it? What did real use reveal that the asset itself doesn't say?",
  skill:
    "skill assets are stored as `skills/<name>/SKILL.md`. Frontmatter typically includes `name`, `description`, and `when_to_use`.",
  command:
    "command assets are markdown with optional frontmatter (`name`, `description`). The body is the prompt template the user invokes.",
  agent:
    "agent assets are markdown with frontmatter describing the agent role (`name`, `description`, optional `tools`, `model`).",
  knowledge: "knowledge assets are reference markdown documents. Include a top-level `# Title` and concise sections.",
  memory:
    "memory assets are short factual notes the user wants persisted across sessions. Frontmatter usually includes `description`.",
  workflow:
    "workflow assets are markdown describing a multi-step process. Include `# <Title>` and ordered `## Step N` sections.",
  script: "script assets are executable text files. Include a shebang and minimal usage comment.",
  env: "env assets are `.env` files holding a group of related CONFIGURATION for an app/service (KEY=VALUE pairs, `#` comments) — URLs, flags, and any credentials it needs. Values may or may not be sensitive; all are protected (key names discoverable, values stay on disk). Inject with `akm env run env:<name> -- <cmd>` (the safe path — values never reach stdout/your context); do NOT run `akm env export` and read its output, as that prints values. For a single sensitive value used on its own for authentication (token, key, cert) use a `secret` instead. Never echo values back to the user.",
  wiki: "wiki assets are markdown reference pages with `# Title` and structured headings.",
  fact: "fact assets are durable stash-level facts (personal/team/project details, coding conventions, stash-meta). Frontmatter SHOULD include `description` and a `category` (personal|team|project|convention|meta); set `pinned: true` only for the small always-injected core. Keep each fact short, high-signal, and self-contained — it is durable context, not an episodic note.",
};

function hintForType(type: string): string {
  return TYPE_HINTS[type] ?? `assets of type "${type}" — produce sensible markdown with optional frontmatter.`;
}

function knownTypeList(): string {
  return Object.keys(TYPE_DIRS).sort().join(", ");
}

/**
 * Common envelope every prompt asks the agent to honour when NO draft file
 * path is available. The wrapper code uses `JSON.parse(stdout)` to extract
 * the payload — anything outside the JSON object will be treated as a parse
 * error.
 */
const RESPONSE_CONTRACT_JSON = [
  "Respond ONLY with a single JSON object. No prose before or after.",
  'Shape: {"ref": "<type>:<name>", "content": "<full file contents>", "frontmatter": {...}, "confidence": <number 0..1>}',
  "`content` is the full file body that will be written if accepted.",
  "`frontmatter` is optional — include it if `content` starts with `---` so reviewers can sanity-check the keys.",
  "`confidence` is REQUIRED. Self-rate this proposal on [0, 1] by how certain you are it materially improves the source asset. Calibrate honestly:",
  "  • 0.90+ — high certainty: fixes a real defect or adds load-bearing missing content; a reviewer would clearly accept.",
  "  • 0.70–0.89 — clear improvement, but a reviewer might reasonably prefer different framing or scope.",
  "  • 0.50–0.69 — marginal / judgment call; might help, might not be worth the churn.",
  "  • Below 0.50 — you are not confident this improves on the source. Prefer returning the source body roughly unchanged with a low score over inventing changes.",
  "Auto-accept gates on confidence ≥ 0.80 by default. Overclaiming ships low-quality changes; underclaiming leaves good ones stuck in queue. Be honest.",
].join("\n");

/**
 * Response contract used when a draft file path is available. Instructs the
 * agent to write the improved asset content directly to the file using its
 * native file-editing tools — no stdout JSON parsing required.
 */
function fileWriteContract(draftFilePath: string): string {
  return [
    `Write the complete improved asset content to: ${draftFilePath}`,
    "Use your file-editing tools to create or overwrite that file.",
    "Do NOT output JSON to stdout. Do NOT print the file contents. Just write the file.",
    "When done, output a single line on stdout: DRAFT_WRITTEN confidence=<0.0-1.0>",
    "`confidence` is REQUIRED and must be your honest self-rated [0, 1] score for this proposal:",
    "  • 0.90+ — fixes a real defect or adds load-bearing missing content; reviewer would clearly accept.",
    "  • 0.70–0.89 — clear improvement, but a reviewer might prefer different framing.",
    "  • 0.50–0.69 — marginal / judgment call.",
    "  • Below 0.50 — not confident; prefer not writing changes at all.",
    "Auto-accept gates on confidence ≥ 0.80. Overclaim → low-quality changes land; underclaim → good changes stuck in queue.",
  ].join("\n");
}

/**
 * Extract a confidence score from a `DRAFT_WRITTEN confidence=<n>` line emitted
 * by an agent following {@link fileWriteContract}. Tolerates trailing prose,
 * surrounding log lines, and missing/invalid confidence (returns `undefined`
 * so callers can keep the proposal but skip auto-accept).
 *
 * Matched forms (case-insensitive, anywhere in stdout):
 *   - `DRAFT_WRITTEN confidence=0.85`
 *   - `DRAFT_WRITTEN confidence=0.85 ...trailing`
 *   - `DRAFT_WRITTEN` (no confidence — returns `undefined`)
 */
export function extractDraftConfidence(stdout: string | undefined): number | undefined {
  if (!stdout) return undefined;
  const match = stdout.match(/\bDRAFT_WRITTEN\b[^\S\r\n]+confidence=([0-9]*\.?[0-9]+)/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return value;
}

/** A previously-rejected proposal injected as verbal-RL context (Reflexion pattern). */
export interface RejectedProposalContext {
  /** Asset ref the rejected proposal targeted. */
  ref: string;
  /** Human-readable rejection reason supplied at review time. */
  reason: string;
  /**
   * Truncated preview of the rejected content (first 500 chars). Helps the
   * agent understand what shape was already tried and refused.
   */
  contentPreview?: string;
}

export interface ReflectPromptInput {
  ref?: string;
  type?: string;
  name?: string;
  /** Current asset content (may be empty when the asset is new). */
  assetContent?: string;
  /** Recent feedback/event lines to feed in as context. */
  feedback?: string[];
  /** Optional schema/lint hints (e.g. lesson-lint findings). */
  schemaHints?: string[];
  /** Related lesson content that may justify consolidating durable guidance. */
  relatedLessons?: Array<{ ref: string; content: string }>;
  /** Optional operator task/focus hint. */
  task?: string;
  /**
   * Standards "rulebook" for this write target — the wiki schema body (for a
   * wiki-page target) or the concatenated convention/meta fact bodies (for a
   * non-wiki asset target). Mutually exclusive by target; empty when neither
   * fires. Injected verbatim as its own prompt section before the asset content.
   */
  standardsContext?: string;
  /**
   * When provided, the agent is instructed to write the improved content
   * directly to this path using its file tools. No stdout JSON is expected.
   * When absent, the agent returns a JSON payload via stdout (legacy path).
   */
  draftFilePath?: string;
  /**
   * Error patterns from earlier assets in the same improve run. When non-empty,
   * a warning section is appended to the prompt so the agent avoids repeating
   * the same mistakes.
   */
  avoidPatterns?: string[];
  /**
   * Last 1–3 archived rejected proposals for this ref. Injected as
   * Reflexion-style verbal-RL context so the agent does not regenerate
   * proposals that have already been reviewed and refused.
   */
  rejectedProposals?: RejectedProposalContext[];
  /**
   * Prior draft content from the previous refinement iteration (R-1 / #372).
   * When set, the agent is asked to critique the draft and produce a better
   * version. Self-Refine arXiv:2303.17651 — iterative feedback+revise loop.
   */
  priorDraft?: string;
}

/**
 * Whether the source asset content has a non-empty `description:` key in its
 * YAML frontmatter. Used by {@link buildReflectPrompt} (#636) to decide whether
 * to inject the synthesize-a-description instruction. Uses an inline regex to
 * avoid pulling the full YAML parser into the prompt module (mirrors the
 * existing inline frontmatter handling here).
 */
function sourceHasNonEmptyDescription(assetContent: string | undefined): boolean {
  if (!assetContent) return false;
  const fmMatch = assetContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) return false;
  const fmBlock = fmMatch[1] ?? "";
  // Match a top-level `description:` line and capture its inline value.
  const descMatch = fmBlock.match(/^description\s*:\s*(.*)$/m);
  if (!descMatch) return false;
  const value = (descMatch[1] ?? "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
  return value.length > 0;
}

/** Result of {@link buildReflectPrompt}. */
export interface ReflectPromptResult {
  /** Full prompt string to forward to the agent/LLM. */
  prompt: string;
  /**
   * Maximum body character count for the proposed content, derived from the
   * same blended-bound formula used by {@link checkReflectSize}. Only set when
   * the source body is ≥ REFLECT_SIZE_GUARD_MIN_BYTES (200 chars). Callers on
   * the LLM path can convert this to a `max_tokens` cap so the model is hard-
   * constrained from the API layer as well as by the prompt rules.
   */
  maxOutputChars?: number;
}

/**
 * Build the prompt for `akm reflect [ref]`. Asks the agent to review an
 * existing asset (plus any negative feedback / lint findings) and propose
 * an improved version. Returns a {@link ReflectPromptResult} containing the
 * prompt string and an optional character ceiling for max-tokens enforcement.
 */
export function buildReflectPrompt(input: ReflectPromptInput): ReflectPromptResult {
  const sections: string[] = [];
  if (input.ref && input.type && input.name) {
    // Change 2 — type-conditioned goal framing
    const isLesson = input.type === "lesson";
    const isSkill = input.type === "skill";
    const goalSentence = isLesson
      ? `Your task is to distill what usage signals reveal about this ${input.type} asset — when to reach for it, what goes wrong without it, and what real use has revealed that the asset itself does not say. Do not reproduce the source content; your proposal must add information the source does not contain.`
      : isSkill
        ? "Your task is to review this skill asset, identify what the feedback and related distilled lessons show is broken, missing, unclear, or durable enough to promote into long-term documentation, and produce a single improved proposal. If the strongest evidence points to companion reference material rather than the main SKILL.md, you may instead propose a skill-adjacent knowledge doc such as `knowledge:skills/<skill>/references/<topic>`."
        : `Your task is to review this ${input.type} asset, identify what the feedback signals as broken, missing, or unclear, and produce an improved version. Do not reproduce the source content unchanged; your proposal must correct or add something the source lacks.`;
    sections.push(goalSentence);
    sections.push(`Target ref: ${input.ref}`);
    sections.push(`Asset-type guidance: ${hintForType(input.type)}`);
  } else {
    sections.push("You are reviewing recent akm feedback and proposing a single improved asset revision.");
    sections.push("No target ref was supplied. Choose the best target from the feedback below and return it in `ref`.");
    sections.push(`Known asset types: ${knownTypeList()}.`);
  }

  if (input.task?.trim()) {
    sections.push(`Task / focus: ${input.task.trim()}`);
  }

  // Change 3 & 4 — feedback moved before asset content; missing else branch added
  if (input.feedback && input.feedback.length > 0) {
    sections.push("Recent feedback / signals:");
    for (const line of input.feedback) sections.push(`- ${line}`);
  } else if (!input.ref) {
    sections.push("Recent feedback / signals:");
    sections.push("- (no feedback events recorded)");
  } else if (input.type === "skill" && input.relatedLessons && input.relatedLessons.length > 0) {
    sections.push(
      "No direct feedback events were recorded. Limit substantive changes to what is justified by the related distilled lessons below; do not speculate beyond that evidence.",
    );
  } else {
    // ref is set but no feedback — explicitly constrain scope to schema compliance
    sections.push(
      "No usage feedback recorded. Limit your proposal to schema and structural improvements only: missing required frontmatter fields, unclear `when_to_use`, ambiguous description, or broken formatting. Do not speculate about runtime weaknesses you have not observed.",
    );
  }

  if (input.standardsContext?.trim()) {
    sections.push("Standards to follow (the rulebook for this target):");
    sections.push(input.standardsContext.trim());
  }

  {
    const resolvedType = input.type ?? (input.ref?.includes(":") ? input.ref.split(":")[0] : "");
    const authoringRules = resolvedType ? authoringRulesForType(resolvedType) : "";
    if (authoringRules) {
      sections.push(authoringRules);
    }

    // #636 — synthesize-a-description instruction. Many source assets (notably
    // scraped docs: `source`/`title`/`scraped`) carry frontmatter but NO
    // `description`. Reflect echoes the source frontmatter, so the proposal
    // inherits the missing description and the promote-time validator
    // (isValidDescription, 20–400 chars) rejects it. The fix is at GENERATION
    // time: when the source lacks a non-empty `description` and the type
    // requires one, tell the model — unmissably — that it MUST author a valid
    // `description`. (The validator/promote path is NOT changed: it must never
    // fabricate content to pass itself.)
    if (resolvedType && requiresDescription(resolvedType) && !sourceHasNonEmptyDescription(input.assetContent)) {
      sections.push(
        [
          "REQUIRED — synthesize a `description` (the source asset has none):",
          `- The source frontmatter does NOT include a non-empty \`description\`, but a ${resolvedType} asset REQUIRES one or the proposal will be rejected at promote time.`,
          `- You MUST author a valid \`description\` in the proposal frontmatter: ${DESCRIPTION_MIN_CHARS}–${DESCRIPTION_MAX_CHARS} characters of plain-prose sentence summarizing what this asset is about.`,
          '- Synthesize it from the asset\'s `title:` frontmatter, its first `# Heading`, or the opening body sentence. Do NOT copy a bare heading fragment (e.g. "Overview", "Named Page", "Key Insight") and do NOT emit a truncated phrase that ends on `:`/`;`/`,` or a hanging connector word.',
        ].join("\n"),
      );
    }
  }

  if (input.assetContent?.trim()) {
    // Cap at 12 000 chars to stay well under OS ARG_MAX when the prompt is
    // passed as a CLI argument to opencode/claude. Large assets (wiki snapshots,
    // long runbooks) would otherwise trigger E2BIG on posix_spawn.
    const REFLECT_CONTENT_CAP = 12_000;
    const body = input.assetContent.trimEnd();
    const truncated = body.length > REFLECT_CONTENT_CAP;
    sections.push(
      truncated
        ? `Current asset content (first ${REFLECT_CONTENT_CAP} chars — full asset is ${body.length} chars):`
        : "Current asset content (verbatim):",
    );
    sections.push("```");
    sections.push(
      truncated ? `${body.slice(0, REFLECT_CONTENT_CAP)}\n... [truncated — focus on the visible portion]` : body,
    );
    sections.push("```");
  } else if (input.ref) {
    sections.push("(No existing content — propose a fresh asset that fits the ref.)");
  } else {
    sections.push("(No existing asset content was supplied.)");
  }

  if (input.schemaHints && input.schemaHints.length > 0) {
    sections.push("Schema / lint hints to address:");
    for (const line of input.schemaHints) sections.push(`- ${line}`);
  }

  if (input.relatedLessons && input.relatedLessons.length > 0) {
    sections.push("Related distilled lessons to evaluate for consolidation:");
    for (const lesson of input.relatedLessons) {
      sections.push(`Lesson ref: ${lesson.ref}`);
      sections.push("```");
      sections.push(lesson.content.trimEnd());
      sections.push("```");
    }
    sections.push(
      "Evaluate whether these lessons contain strong evidence of factual, repeatable guidance that should be promoted into long-term skill documentation.",
    );
    sections.push(
      "Promote only guidance that is durable, generally applicable, and supported by repeated evidence. Do not copy anecdotal details, one-off incidents, or duplicate wording verbatim.",
    );
    sections.push(
      "If the guidance belongs in the main skill instructions, update the skill proposal. If it belongs in a companion reference document, return a `knowledge:skills/<skill>/references/<topic>` proposal instead.",
    );
  }

  if (input.rejectedProposals && input.rejectedProposals.length > 0) {
    const lines: string[] = ["## Previously Rejected Proposals"];
    lines.push(
      "The following proposals for this ref were already reviewed and rejected. " +
        "Do NOT reproduce the same content or the same structural shape. " +
        "Your new proposal must meaningfully differ from each of these in its approach, framing, or evidence used.",
    );
    for (const rp of input.rejectedProposals) {
      lines.push(`\nRef: ${rp.ref}`);
      lines.push(`Rejection reason: ${rp.reason}`);
      if (rp.contentPreview) {
        lines.push("Rejected content preview:");
        lines.push("```");
        lines.push(rp.contentPreview);
        lines.push("```");
      }
    }
    sections.push(lines.join("\n"));
  }

  if (input.avoidPatterns && input.avoidPatterns.length > 0) {
    sections.push(
      `## Avoid These Patterns\nPrevious assets in this run produced these errors — do not repeat them:\n${input.avoidPatterns.map((e) => `- ${e}`).join("\n")}`,
    );
  }

  // R-1 / #372: Self-Refine (arXiv:2303.17651) — inject prior draft as critique target.
  // On refinement iterations (iter > 0), the agent is shown its previous proposal
  // and asked to self-critique and improve it rather than starting from scratch.
  if (input.priorDraft?.trim()) {
    sections.push(
      "## Self-Refine: Critique and Improve\n" +
        "The following is your previous draft proposal. " +
        "Identify specific weaknesses: missing evidence, vague wording, incomplete frontmatter, " +
        "or claims that duplicate existing content without adding new signal. " +
        "Then produce an improved version that addresses those weaknesses. " +
        "The revised proposal must be meaningfully better than the draft below — " +
        "do not return the same content unchanged.\n\n" +
        "Previous draft:\n```\n" +
        input.priorDraft.trimEnd() +
        "\n```",
    );
  }

  sections.push(
    "Produce a single proposal that addresses the feedback and respects the asset-type contract. If the proposal's frontmatter is missing `when_to_use`, you MUST generate one — a one-line trigger sentence describing exactly when a user should reach for this asset.",
  );

  // Content-preservation safety rails (#reflect-pipeline-fixes).
  // These rules counter the observed failure modes where reflect rewrites
  // asset content into shorter prose, drops concrete structure, or strips
  // load-bearing frontmatter. Loud and explicit so small models follow.
  //
  // maxOutputChars is hoisted so the return value can include it for callers
  // on the LLM path that want to set a hard max_tokens cap on the request.
  let maxOutputChars: number | undefined;
  if (input.ref && input.assetContent?.trim()) {
    // Strip frontmatter to get source body length — mirrors checkReflectSize which
    // compares body-only lengths. Inline regex avoids importing parseFrontmatter.
    const rawContent = input.assetContent.trimEnd();
    const fmBodyMatch = rawContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const sourceBodyLen = (fmBodyMatch ? fmBodyMatch[1] : rawContent).trim().length;
    // Compute concrete char bounds matching checkReflectSize constants:
    //   REFLECT_SIZE_GUARD_MIN_BYTES=200, REFLECT_SHRINK_RATIO_MIN=0.5,
    //   REFLECT_ABSOLUTE_FLOOR_BYTES=150, REFLECT_EXPAND_RATIO_MAX=2.5,
    //   REFLECT_ABSOLUTE_CEILING_BYTES=2500, REFLECT_ABSOLUTE_MAX_BYTES=25000.
    // Embed concrete counts only when the gate will actually fire (source >= 200 chars).
    const showCharBounds = sourceBodyLen >= 200;
    const minChars = Math.max(Math.round(0.5 * sourceBodyLen), 150);
    const maxChars = Math.min(Math.max(Math.round(2.5 * sourceBodyLen), 2500), 25000);
    if (showCharBounds) maxOutputChars = maxChars;
    sections.push(
      [
        "## Content preservation rules (MUST follow)",
        "1. PRESERVE ALL concrete content: code blocks, fenced snippets, CLI commands, numbered/bulleted checklists, tables, YAML/JSON examples, file paths, configuration keys, environment variable names, and CSS/HTML selectors. These are load-bearing — do NOT replace them with prose summaries.",
        "2. PRESERVE the source asset's frontmatter. The post-processor reassembles the final asset from the original frontmatter plus your body. Do NOT emit `---` frontmatter delimiters at the top of `content` — start `content` with the markdown body (e.g. `# Heading` or the first paragraph). If you include frontmatter anyway, identity fields (`name`, `ref`, `id`, `slug`, `type`) will be reset to the original values.",
        showCharBounds
          ? `3. DO NOT shrink the asset. Your body must be at least ${minChars} characters (source body is ${sourceBodyLen} chars; floor is 50%). If you genuinely need to remove a major section, explain why in a comment line at the top of the body (e.g. \`<!-- removed obsolete section X because ... -->\`).`
          : "3. DO NOT shrink the asset dramatically. The improved body must be at least 50% of the source body length. If you genuinely need to remove a major section, explain why in a comment line at the top of the body (e.g. `<!-- removed obsolete section X because ... -->`).",
        showCharBounds
          ? `4. DO NOT pad the asset with speculative material. Your body must be at most ${maxChars} characters (source body is ${sourceBodyLen} chars; ceiling is 250%). Do not add invented sections, hypothetical examples, or padding prose.`
          : "4. DO NOT pad the asset with speculative material. The improved body must be at most 250% of the source body length unless the feedback explicitly requests added sections.",
        "5. Improve clarity of surrounding prose, fix structural issues, add missing required frontmatter fields. Do NOT rewrite a runbook into an essay.",
      ].join("\n"),
    );
  }
  if (!input.draftFilePath && input.ref) {
    // Reinforce that the `ref` field is mandatory and must exactly match the target.
    // Small models frequently omit `ref` from the response JSON, causing parse errors.
    sections.push(`IMPORTANT: The JSON "ref" field is REQUIRED. It MUST be exactly: "${input.ref}"`);
  }
  sections.push(input.draftFilePath ? fileWriteContract(input.draftFilePath) : RESPONSE_CONTRACT_JSON);
  return { prompt: sections.join("\n\n"), ...(maxOutputChars !== undefined ? { maxOutputChars } : {}) };
}

export interface ProposePromptInput {
  type: string;
  name: string;
  task: string;
  /** Optional extra schema hints. */
  schemaHints?: string[];
  /**
   * Standards "rulebook" for this write target — the wiki schema body (for a
   * wiki-page target) or the concatenated convention/meta fact bodies (for a
   * non-wiki asset target). Mutually exclusive by target; empty when neither
   * fires. Injected verbatim as its own prompt section before the proposal
   * contract.
   */
  standardsContext?: string;
  /**
   * When provided, the agent is instructed to write the new asset content
   * directly to this path using its file tools. No stdout JSON is expected.
   * When absent, the agent returns a JSON payload via stdout (legacy path).
   */
  draftFilePath?: string;
}

/**
 * Build the prompt for `akm propose <type> <name> --task ...`. Asks the
 * agent to author a brand-new asset of the given type fulfilling `task`.
 */
export function buildProposePrompt(input: ProposePromptInput): string {
  const sections: string[] = [];
  sections.push(`Author a new akm stash asset of type "${input.type}" named "${input.name}".`);
  sections.push(`Task: ${input.task}`);
  sections.push(`Asset-type guidance: ${hintForType(input.type)}`);
  sections.push(`(Known asset types: ${knownTypeList()}.)`);
  if (input.schemaHints && input.schemaHints.length > 0) {
    sections.push("Schema / lint hints:");
    for (const line of input.schemaHints) sections.push(`- ${line}`);
  }
  if (input.standardsContext?.trim()) {
    sections.push("Standards to follow (the rulebook for this target):");
    sections.push(input.standardsContext.trim());
  }
  {
    const authoringRules = authoringRulesForType(input.type);
    if (authoringRules) {
      sections.push(authoringRules);
    }
  }
  sections.push("Produce a single proposal that, if accepted, would land as the asset described above.");
  sections.push(input.draftFilePath ? fileWriteContract(input.draftFilePath) : RESPONSE_CONTRACT_JSON);
  return sections.join("\n\n");
}

export interface SchemaRepairPromptInput {
  ref: string;
  type: string;
  name: string;
  /** Validation failure reason (e.g. "missing description"). */
  reason: string;
  /** Current verbatim file content of the failing asset. */
  assetContent: string;
  /**
   * Standards "rulebook" for this target — wiki schema (wiki page) or stash
   * convention/meta facts (non-wiki asset). Empty/omitted when neither fires;
   * gated on non-empty before injection.
   */
  standardsContext?: string;
  /**
   * When provided, the agent writes directly to this file path using its
   * file-editing tools. When absent, the agent returns a JSON payload via
   * stdout (same contract as reflect/propose).
   */
  draftFilePath?: string;
}

/**
 * Build the prompt for the schema repair pass in `akm improve`. Asks the
 * agent to add the minimal required frontmatter to an asset that failed
 * validation — without rewriting the body.
 */
export function buildSchemaRepairPrompt(input: SchemaRepairPromptInput): string {
  const sections: string[] = [];
  sections.push(
    `This ${input.type} asset failed schema validation with the error: "${input.reason}". ` +
      `Your task is to fix the schema issue by adding or correcting the missing/invalid field(s) ` +
      `while preserving all existing content.`,
  );
  sections.push(`Target ref: ${input.ref}`);
  sections.push(`Schema requirements for ${input.type} assets: ${hintForType(input.type)}`);
  if (input.standardsContext?.trim()) {
    sections.push("Standards to follow (the rulebook for this target):");
    sections.push(input.standardsContext.trim());
  }
  {
    const authoringRules = authoringRulesForType(input.type);
    if (authoringRules) {
      sections.push(authoringRules);
    }
  }
  const CONTENT_CAP = 3000;
  const body = input.assetContent.trimEnd();
  const truncated = body.length > CONTENT_CAP;
  sections.push("Current asset content (first 3000 chars — sufficient to generate missing frontmatter):");
  sections.push("```");
  sections.push(truncated ? `${body.slice(0, CONTENT_CAP)}\n... [truncated]` : body);
  sections.push("```");
  sections.push(
    "Produce the minimal fix: add ONLY the missing required frontmatter field(s). " +
      "Do not rewrite the body unless it is empty. " +
      "If `description` is missing, generate a concise one-sentence description from the content. " +
      "If `when_to_use` is missing, generate a one-line trigger sentence. " +
      "Preserve all existing frontmatter keys and the full body verbatim.",
  );
  sections.push(input.draftFilePath ? fileWriteContract(input.draftFilePath) : RESPONSE_CONTRACT_JSON);
  return sections.join("\n\n");
}

/**
 * Parse agent stdout into a proposal payload. The agent contract requires a
 * single JSON object; anything else is reported as a parse error so callers
 * can map to {@link AgentFailureReason} `parse_error`.
 *
 * Resilient to two common local-LLM failure modes:
 *  1. `<think>…</think>` blocks emitted before the JSON (stripped by `stripJsonFences`).
 *  2. Prose preamble / postamble around the JSON object (handled by `extractEmbeddedJson`).
 */
export function parseAgentProposalPayload(stdout: string): AgentProposalPayload {
  // Strip <think> blocks and fences, then attempt full parse with embedded fallback.
  const trimmed = stripCodeFences(stripThinkBlocks(stdout)).trim();
  if (!trimmed) throw new Error("agent produced empty output");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (directErr) {
    // Agent output contains prose before/after the JSON object (e.g. a local
    // LLM that narrates before responding). Try extracting the first balanced
    // top-level `{…}` from the text rather than failing immediately.
    const embedded = parseEmbeddedJsonResponse<Record<string, unknown>>(trimmed);
    if (!embedded) throw directErr;
    parsed = embedded;
  }

  if (typeof parsed.ref !== "string" || !parsed.ref.trim()) {
    throw new Error('agent response missing required string field "ref"');
  }
  if (typeof parsed.content !== "string" || !parsed.content.trim()) {
    throw new Error('agent response missing required string field "content"');
  }
  const out: AgentProposalPayload = {
    ref: parsed.ref.trim(),
    content: parsed.content,
  };
  if (parsed.frontmatter && typeof parsed.frontmatter === "object" && !Array.isArray(parsed.frontmatter)) {
    out.frontmatter = parsed.frontmatter as Record<string, unknown>;
  }
  // Phase 6A: extract optional `confidence` (number in [0, 1]). Clamp gently
  // rather than reject — a model that returns 1.0 or 0 with extra precision
  // (e.g. 1.0000001) should still surface a usable score. Anything that isn't
  // a finite number is dropped so downstream `createProposal` can rely on the
  // shape invariant.
  if (typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)) {
    const clamped = Math.max(0, Math.min(1, parsed.confidence));
    out.confidence = clamped;
  }
  return out;
}

/**
 * Strip `\`\`\`json … \`\`\`` fences and `<think>…</think>` reasoning blocks
 * from agent output. Thin wrapper around `core/parse` helpers, kept exported
 * for backward compatibility (re-exported from `integrations/agent/index.ts`).
 */
export function stripJsonFences(text: string): string {
  return stripCodeFences(stripThinkBlocks(text));
}
