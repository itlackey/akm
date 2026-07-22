// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk 1.5 (WI-1.5.1, D1.5-4) — the §2.3 "compile-time safety mitigation"
 * table for AKM's own presentation metadata. EXTENDED by chunk-2 WI-C
 * (`docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §2) to carry the per-`type`
 * renderer NAME + action builder, so this table becomes the `TYPE_PRESENTATION`
 * data table §2 mandates ("Renderer/action = data table keyed on the open
 * `type`, pointing at a named-function core module").
 *
 * The open type token (chunk 1.5) trades the deleted closed asset-type
 * union's exhaustiveness checking for a runtime lookup. `TYPE_PRESENTATION`
 * restores that exhaustiveness for AKM's OWN known types (the compiler
 * demands an entry whenever {@link KnownType} gains a member), while
 * {@link presentationFor} stays open over `string` so foreign/adapter types
 * still resolve to a sane generic fallback instead of `undefined`/a throw.
 *
 * ── renderer/action provenance (WI-C, §2) ──
 *
 * The `renderer` NAMES and `action` builders below are the SINGLE SOURCE OF
 * TRUTH for search-hit rendering — chunk-3 folded the old mutable renderer/
 * action registry singleton into this static table (reached via
 * {@link defaultRendererRegistry}). They cover all built-in types — INCLUDING
 * the 15th type `instruction` (a read-like-knowledge markdown doc added for the
 * format-family adapters) and the 6 "static-only" mappings
 * (script/skill/command/agent/knowledge/memory) — §6 "6 renderer mappings".
 * The workflow action is the one function-valued builder; its
 * `buildWorkflowAction` body (`output/renderers.ts` — a cycle-sensitive module)
 * is reproduced inline here rather than imported, to keep this leaf import-free
 * (only `recognition-util`, D1-5's pure sink); `tests/core/adapter/
 * akm-presentation.test.ts` pins the renderer/action values against drift.
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
   * Action-hint builder for search results (§2; ← `ACTION_BUILDERS`). Takes the
   * item ref, returns the one-line "what to do with this hit" string.
   */
  action?: (ref: string) => string;
}

/** POSIX-shell single-quote a value — inlined from `output/renderers.ts#shellQuote` (cycle-sensitive; see file header). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Reproduced from `output/renderers.ts#buildWorkflowAction` — the one function-valued `ACTION_BUILDERS.workflow` entry. */
function buildWorkflowAction(ref: string): string {
  return `Resume the active run or start a new run with \`akm workflow next ${shellQuote(ref)}\`.`;
}

/**
 * Exhaustive over {@link KnownType} — a HAND-WRITTEN literal, not derived
 * from `KNOWN_TYPES` programmatically, so the compiler rejects this object
 * if a `KNOWN_TYPES` member is added without a corresponding entry here
 * (TypeScript's version of the `§7.3 shipped-assets lint` cross-check the
 * plan describes for later — "adding a KNOWN_TYPE forces a decision").
 *
 * `renderer`/`action` are the built-in search-hit rendering data (WI-C, §2) —
 * see the file header.
 */
export const TYPE_PRESENTATION: Record<KnownType, Presentation> = {
  skill: { label: "Skill", renderer: "skill-md", action: (ref) => `akm show ${ref} -> follow the instructions` },
  command: {
    label: "Command",
    renderer: "command-md",
    action: (ref) => `akm show ${ref} -> fill placeholders and dispatch`,
  },
  agent: { label: "Agent", renderer: "agent-md", action: (ref) => `akm show ${ref} -> dispatch with full prompt` },
  knowledge: {
    label: "Knowledge",
    renderer: "knowledge-md",
    action: (ref) => `akm show ${ref} -> read reference material`,
  },
  workflow: { label: "Workflow", renderer: "workflow-md", action: (ref) => buildWorkflowAction(ref) },
  script: { label: "Script", renderer: "script-source", action: (ref) => `akm show ${ref} -> execute the run command` },
  memory: { label: "Memory", renderer: "memory-md", action: (ref) => `akm show ${ref} -> recall context` },
  env: {
    label: "Env",
    renderer: "env-file",
    action: (ref) =>
      `akm show ${ref} -> inspect key names; akm env run ${ref} -- <command> -> run with the whole .env injected (prefer --clean to minimize inherited parent env; child stdout is not redacted). akm env export ${ref} --out <file> writes a sourceable script (values to a file, not stdout).`,
  },
  secret: {
    label: "Secret",
    renderer: "secret-file",
    action: (ref) =>
      `akm show ${ref} -> name only (value never shown); akm secret path ${ref} -> file path; akm secret run ${ref} <VAR> -- <command> -> run with value injected into $VAR`,
  },
  lesson: {
    label: "Lesson",
    renderer: "lesson-md",
    action: (ref) => `akm show ${ref} -> read the lesson and apply when_to_use`,
  },
  task: {
    label: "Task",
    renderer: "task-yaml",
    action: (ref) =>
      `akm tasks show ${ref.replace(/^task:/, "")} -> inspect; akm tasks run <id> -> run now; akm tasks remove <id> -> unschedule`,
  },
  session: {
    label: "Session",
    renderer: "session-md",
    action: (ref) =>
      `akm show ${ref} -> read the session summary; follow the \`access\` frontmatter to open the raw log at \`log_path\``,
  },
  fact: {
    label: "Fact",
    renderer: "fact-md",
    action: (ref) => `akm show ${ref} -> read the stash fact and apply it as durable context`,
  },
  // `instruction` (CLAUDE.md / AGENTS.md) is a read-like-knowledge markdown
  // doc (spec §6/§7 instruction row, maintainer resolution 2026-07): it REUSES
  // the `knowledge-md` renderer and mirrors knowledge's read action, so an
  // instruction hit renders exactly like knowledge instead of the generic
  // fallback (the parity guard in akm-presentation.test.ts pins this).
  instruction: {
    label: "Instruction",
    renderer: "knowledge-md",
    action: (ref) => `akm show ${ref} -> read the project instructions`,
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
 * Renderer-name / action-builder lookup surface for search-hit rendering.
 *
 * Chunk-3 folded the old mutable renderer/action registry singleton into this
 * static presentation table. The registry indirection is kept as an interface
 * so tests can inject an isolated lookup without mutating module state; the
 * default implementation reads the built-in {@link TYPE_PRESENTATION} via
 * {@link presentationFor}.
 */
export interface RendererRegistry {
  rendererNameFor(type: string): string | undefined;
  actionBuilderFor(type: string): ((ref: string) => string) | undefined;
}

export const defaultRendererRegistry: RendererRegistry = {
  rendererNameFor(type) {
    return presentationFor(type).renderer;
  },
  actionBuilderFor(type) {
    return presentationFor(type).action;
  },
};
