// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `TYPE_PRESENTATION` table of AKM's own presentation metadata: the per-`type`
 * renderer NAME, a data table keyed on the open
 * `type`, pointing at a named-function core module.
 *
 * The open type token trades the deleted closed asset-type
 * union's exhaustiveness checking for a runtime lookup. `TYPE_PRESENTATION`
 * restores that exhaustiveness for AKM's OWN known types (the compiler
 * demands an entry whenever {@link KnownType} gains a member), while
 * {@link presentationFor} stays open over `string` so foreign/adapter types
 * still resolve to a sane generic fallback instead of `undefined`/a throw.
 *
 * ── renderer provenance ──
 *
 * The `renderer` NAMES below are the SINGLE SOURCE OF
 * TRUTH for search-hit rendering (reached via {@link presentationFor}).
 * They cover all built-in types — INCLUDING
 * the 15th type `instruction` (a read-like-knowledge markdown doc added for the
 * format-family adapters) and the 6 "static-only" mappings
 * (script/skill/command/agent/knowledge/memory).
 * `tests/core/adapter/akm-presentation.test.ts` pins the renderer values against drift.
 */

import { isKnownType, type KnownType } from "./recognition-util";

export interface Presentation {
  /** Human-readable label for this asset type (e.g. "Skill", "Knowledge"). */
  label: string;
  /**
   * Primary renderer NAME for this `type` (§2; ← `TYPE_TO_RENDERER`). Optional
   * so a foreign/adapter `type` resolves to the generic fallback (no renderer)
   * instead of being forced onto one AKM owns.
   */
  renderer?: string;
  /**
   * Whether a lexical Markdown fragment can replace this type's public ref.
   * Types whose advertised action consumes the whole parent stay canonical:
   * a fragment is evidence for ranking, never an executable target.
   */
  fragmentRef?: boolean;
}

/**
 * Exhaustive over {@link KnownType} — a HAND-WRITTEN literal, not derived
 * from `KNOWN_TYPES` programmatically, so the compiler rejects this object
 * if a `KNOWN_TYPES` member is added without a corresponding entry here
 * (TypeScript's version of the `§7.3 shipped-assets lint` cross-check the
 * plan describes for later — "adding a KNOWN_TYPE forces a decision").
 *
 * `renderer` is the built-in search-hit rendering data (WI-C, §2) —
 * see the file header.
 */
export const TYPE_PRESENTATION: Record<KnownType, Presentation> = {
  skill: {
    label: "Skill",
    renderer: "skill-md",
    fragmentRef: false,
  },
  command: {
    label: "Command",
    renderer: "command-md",
    fragmentRef: false,
  },
  agent: {
    label: "Agent",
    renderer: "agent-md",
    fragmentRef: false,
  },
  knowledge: {
    label: "Knowledge",
    renderer: "knowledge-md",
  },
  workflow: {
    label: "Workflow",
    renderer: "workflow-md",
    fragmentRef: false,
  },
  script: {
    label: "Script",
    renderer: "script-source",
    fragmentRef: false,
  },
  memory: { label: "Memory", renderer: "memory-md" },
  env: {
    label: "Env",
    renderer: "env-file",
  },
  secret: {
    label: "Secret",
    renderer: "secret-file",
  },
  lesson: {
    label: "Lesson",
    renderer: "lesson-md",
  },
  task: {
    label: "Task",
    renderer: "task-yaml",
    fragmentRef: false,
  },
  session: {
    label: "Session",
    renderer: "session-md",
  },
  fact: {
    label: "Fact",
    renderer: "fact-md",
  },
  // `instruction` (CLAUDE.md / AGENTS.md) is a read-like-knowledge markdown
  // doc: it REUSES
  // the `knowledge-md` renderer and mirrors knowledge's read action, so an
  // instruction hit renders exactly like knowledge instead of the generic
  // fallback (the parity guard in akm-presentation.test.ts pins this).
  instruction: {
    label: "Instruction",
    renderer: "knowledge-md",
    fragmentRef: false,
  },
  // `rule` (rules/) is a short bullet list of standing agent rules. It reads like
  // knowledge (same renderer).
  rule: {
    label: "Rule",
    renderer: "knowledge-md",
    fragmentRef: false,
  },
};

/** Generic fallback for a type outside {@link KNOWN_TYPES} — never `undefined`, never a throw. */
const DEFAULT_PRESENTATION: Presentation = { label: "Asset" };

/**
 * Open-string lookup with a generic, non-`undefined` fallback (plan §2.3).
 * `undefined` (no type known yet) and any foreign/adapter type both resolve
 * to {@link DEFAULT_PRESENTATION}; only AKM's own {@link KNOWN_TYPES} get a
 * type-specific presentation.
 */
export function presentationFor(type: string | undefined): Presentation {
  if (type !== undefined && isKnownType(type)) return TYPE_PRESENTATION[type];
  return DEFAULT_PRESENTATION;
}

/**
 * A missing declaration means a read-like reference or foreign type can expose
 * a safe selector. Built-in executable and instruction-bearing types opt out
 * explicitly above: their search match can be a fragment, but the advertised
 * action needs the parent canonical ref and its complete context.
 */
export function allowsFragmentRef(type: string): boolean {
  return presentationFor(type).fragmentRef !== false;
}
