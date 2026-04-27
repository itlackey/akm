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
    "lesson assets MUST start with frontmatter containing `description` and `when_to_use` keys (both non-empty). Body should be 1–3 short paragraphs of practical guidance.",
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
 * Common envelope every prompt asks the agent to honour. The wrapper code
 * uses `JSON.parse(stdout)` to extract the payload — anything outside the
 * JSON object will be treated as a parse error.
 */
const RESPONSE_CONTRACT = [
  "Respond ONLY with a single JSON object. No prose before or after.",
  'Shape: {"ref": "<type>:<name>", "content": "<full file contents>", "frontmatter": {...}}',
  "`content` is the full file body that will be written if accepted.",
  "`frontmatter` is optional — include it if `content` starts with `---` so reviewers can sanity-check the keys.",
].join("\n");

export interface ReflectPromptInput {
  ref: string;
  type: string;
  name: string;
  /** Current asset content (may be empty when the asset is new). */
  assetContent?: string;
  /** Recent feedback/event lines to feed in as context. */
  feedback?: string[];
  /** Optional schema/lint hints (e.g. lesson-lint findings). */
  schemaHints?: string[];
}

/**
 * Build the prompt for `akm reflect [ref]`. Asks the agent to review an
 * existing asset (plus any negative feedback / lint findings) and propose
 * an improved version. Returns a single string — the agent runtime will
 * forward it as the trailing positional arg.
 */
export function buildReflectPrompt(input: ReflectPromptInput): string {
  const sections: string[] = [];
  sections.push(
    `You are reviewing an akm stash asset (${input.type}) called "${input.name}" and proposing an improved version.`,
  );
  sections.push(`Target ref: ${input.ref}`);
  sections.push(`Asset-type guidance: ${hintForType(input.type)}`);

  if (input.assetContent && input.assetContent.trim()) {
    sections.push("Current asset content (verbatim):");
    sections.push("```");
    sections.push(input.assetContent.trimEnd());
    sections.push("```");
  } else {
    sections.push("(No existing content — propose a fresh asset that fits the ref.)");
  }

  if (input.feedback && input.feedback.length > 0) {
    sections.push("Recent feedback / signals:");
    for (const line of input.feedback) sections.push(`- ${line}`);
  }

  if (input.schemaHints && input.schemaHints.length > 0) {
    sections.push("Schema / lint hints to address:");
    for (const line of input.schemaHints) sections.push(`- ${line}`);
  }

  sections.push("Produce a single proposal that addresses the feedback and respects the asset-type contract.");
  sections.push(RESPONSE_CONTRACT);
  return sections.join("\n\n");
}

export interface ProposePromptInput {
  type: string;
  name: string;
  task: string;
  /** Optional extra schema hints. */
  schemaHints?: string[];
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
  sections.push(RESPONSE_CONTRACT);
  return sections.join("\n\n");
}

/**
 * Parse agent stdout into a proposal payload. The agent contract requires a
 * single JSON object; anything else is reported as a parse error so callers
 * can map to {@link AgentFailureReason} `parse_error`.
 */
export function parseAgentProposalPayload(stdout: string): AgentProposalPayload {
  const trimmed = stripJsonFences(stdout).trim();
  if (!trimmed) throw new Error("agent produced empty output");
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
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
 * Strip `\`\`\`json … \`\`\`` fences if the agent wrapped its JSON output.
 * Mirrors the same helper in `src/llm/client.ts` but kept local here so
 * `agent/` does not import from `llm/` (the boundary is one-way per
 * v1 spec §9.7 — agents are shell-out only).
 */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) return fenced[1] ?? trimmed;
  return trimmed;
}
