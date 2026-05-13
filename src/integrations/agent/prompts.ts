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

import { TYPE_DIRS } from "../../core/asset-spec";
import { parseEmbeddedJsonResponse, stripCodeFences, stripThinkBlocks } from "../../core/parse";

/** Agent-returned proposal payload (after JSON parse). */
export interface AgentProposalPayload {
  ref: string;
  content: string;
  frontmatter?: Record<string, unknown>;
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
  vault:
    "vault assets store environment variables (KEY=VALUE pairs). Comments use `#`. Never echo secret values back to the user.",
  wiki: "wiki assets are markdown reference pages with `# Title` and structured headings.",
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
  'Shape: {"ref": "<type>:<name>", "content": "<full file contents>", "frontmatter": {...}}',
  "`content` is the full file body that will be written if accepted.",
  "`frontmatter` is optional — include it if `content` starts with `---` so reviewers can sanity-check the keys.",
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
    "When you are done writing the file, output a single line: DRAFT_WRITTEN",
  ].join("\n");
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
}

/**
 * Build the prompt for `akm reflect [ref]`. Asks the agent to review an
 * existing asset (plus any negative feedback / lint findings) and propose
 * an improved version. Returns a single string — the agent runtime will
 * forward it as the trailing positional arg.
 */
export function buildReflectPrompt(input: ReflectPromptInput): string {
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

  if (input.assetContent?.trim()) {
    sections.push("Current asset content (verbatim):");
    sections.push("```");
    sections.push(input.assetContent.trimEnd());
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

  if (input.avoidPatterns && input.avoidPatterns.length > 0) {
    sections.push(
      `## Avoid These Patterns\nPrevious assets in this run produced these errors — do not repeat them:\n${input.avoidPatterns.map((e) => `- ${e}`).join("\n")}`,
    );
  }

  sections.push(
    "Produce a single proposal that addresses the feedback and respects the asset-type contract. If the proposal's frontmatter is missing `when_to_use`, you MUST generate one — a one-line trigger sentence describing exactly when a user should reach for this asset.",
  );
  sections.push(input.draftFilePath ? fileWriteContract(input.draftFilePath) : RESPONSE_CONTRACT_JSON);
  return sections.join("\n\n");
}

export interface ProposePromptInput {
  type: string;
  name: string;
  task: string;
  /** Optional extra schema hints. */
  schemaHints?: string[];
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
