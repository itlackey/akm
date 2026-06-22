// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Canonical HARD authoring rules — the single source of truth shared by the
 * proposal validators (which REJECT violations) and the improve/authoring
 * prompts (which must TELL the agent the same rules, in the same words).
 *
 * Why this module exists: authoring rules were duplicated and drifted across
 * prompt templates. `distill-lesson-system.md` told the model "80–200 chars"
 * while the validator enforced 20–400; reflect's prompt omitted the
 * no-pseudo-frontmatter / single-fence rules entirely, so reflect generated
 * proposals that the gate then rejected and that got stuck in the queue.
 *
 * The fix: the numeric bounds live HERE and are imported by both the validators
 * (`isValidDescription` / `isValidWhenToUse` in proposal-quality-validators.ts)
 * and the prompt text (`authoringRulesForType`). The agent-facing rule prose
 * sits next to the bounds it describes, so a developer changing a validator
 * sees the prompt copy that must change with it. `tests/authoring-rules-*`
 * asserts the two representations stay consistent.
 *
 * SCOPE: only HARD rules (a validator rejects the proposal if violated) belong
 * here. Soft/style conventions (voice, paragraph count, "include a # Title")
 * are user-editable and flow through the separate `standardsContext` seam
 * (stash `category: convention` facts) — NOT this module.
 */

// ── Canonical numeric bounds (imported by the validators — do not duplicate) ──

/** `description` length bounds (chars). Enforced by `isValidDescription`. */
export const DESCRIPTION_MIN_CHARS = 20;
export const DESCRIPTION_MAX_CHARS = 400;

/** `when_to_use` length bounds (chars). Enforced by `isValidWhenToUse`. */
export const WHEN_TO_USE_MIN_CHARS = 15;
export const WHEN_TO_USE_MAX_CHARS = 400;

// ── Agent-facing rule prose (mirrors the validator checks one-for-one) ────────

/**
 * Rules that apply to any markdown asset authored with YAML frontmatter + a
 * body. Enforced by `detectDoubleFrontmatter` (currently fires for lesson
 * proposals, but the rules are universally correct, so we state them for every
 * type to prevent the same defect class elsewhere).
 */
const FRONTMATTER_BODY_RULES: readonly string[] = [
  "Emit EXACTLY TWO `---` fence lines — the opening and closing of the YAML frontmatter. Do NOT use `---` as a horizontal rule anywhere in the body.",
  "Do NOT restate `description:` or `when_to_use:` inside the body (no `**description:** …` or `**when_to_use:** …` lines). Those keys belong in the frontmatter ONLY.",
];

/** Rules for the `description` frontmatter field. Enforced by `isValidDescription`. */
const DESCRIPTION_RULES: readonly string[] = [
  `\`description\` must be ${DESCRIPTION_MIN_CHARS}–${DESCRIPTION_MAX_CHARS} characters of plain-prose sentence — no leading digit or markdown marker, balanced backticks, and it must NOT end with \`:\`, \`;\`, or \`,\` (those read as truncation).`,
  '`description` must NOT be a section-heading fragment (e.g. "Overview", "Key points", "Summary"), a code fragment (must not start with `def`/`function`/`class`/`const`/…), or end on a hanging connector word ("a", "the", "and", "to", …).',
  "`description` must NOT merely restate the asset's ref/name; write what the asset actually does.",
  '`description` should NOT start with "When" — that phrasing belongs in `when_to_use`.',
];

/** Rules for the `when_to_use` frontmatter field. Enforced by `isValidWhenToUse`. */
const WHEN_TO_USE_RULES: readonly string[] = [
  `\`when_to_use\` is REQUIRED and must be ${WHEN_TO_USE_MIN_CHARS}–${WHEN_TO_USE_MAX_CHARS} characters describing a concrete trigger. Never write the circular fallback "When working with <name>".`,
  "`description` and `when_to_use` must be different from each other.",
];

/**
 * Asset types that carry a `description` and a body where the
 * frontmatter/body rules apply. (Types without those — if any are added later —
 * simply fall through to the cross-cutting block.)
 */
const DESCRIPTION_TYPES = new Set(["lesson", "knowledge", "memory", "skill", "command", "agent", "workflow", "fact"]);

/** Types where `when_to_use` is a HARD requirement (validator rejects if absent). */
const WHEN_TO_USE_TYPES = new Set(["lesson"]);

/**
 * Build the hard-rules block for a given asset type, ready to inject as a prompt
 * section. Returns `""` for an unknown type (no over-claiming). The block is
 * deterministic so prompt snapshots stay stable.
 *
 * Inject this VERBATIM into every improve/authoring prompt that creates or edits
 * an asset of `type`, so the agent is told exactly what the gate will reject.
 */
export function authoringRulesForType(type: string): string {
  const rules: string[] = [...FRONTMATTER_BODY_RULES];
  if (DESCRIPTION_TYPES.has(type)) rules.push(...DESCRIPTION_RULES);
  if (WHEN_TO_USE_TYPES.has(type)) rules.push(...WHEN_TO_USE_RULES);
  if (rules.length === 0) return "";
  const heading = `Hard authoring rules for ${type} assets (the validator REJECTS proposals that violate these):`;
  return [heading, ...rules.map((r) => `- ${r}`)].join("\n");
}
