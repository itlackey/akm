// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The compile-time safety table for AKM's own presentation metadata. It
 * carries the per-`type` renderer NAME + action builder as the
 * `TYPE_PRESENTATION` data table: renderer/action is a data table keyed on
 * the open `type`, pointing at a named-function core module.
 *
 * The open type token trades a closed asset-type union's exhaustiveness
 * checking for a runtime lookup. `TYPE_PRESENTATION` restores that
 * exhaustiveness for AKM's OWN known types (the compiler demands an entry
 * whenever {@link KnownType} gains a member), while {@link presentationFor}
 * stays open over `string` so foreign/adapter types still resolve to a sane
 * generic fallback instead of `undefined`/a throw.
 *
 * ── renderer/action provenance ──
 *
 * The `renderer` NAMES and `action` builders below are the SINGLE SOURCE OF
 * TRUTH for search-hit rendering (reached via {@link presentationFor}). They
 * cover all built-in types — INCLUDING `instruction` (a read-like-knowledge
 * markdown doc added for the format-family adapters) and the 6 "static-only"
 * mappings (script/skill/command/agent/knowledge/memory).
 * The workflow action is the one function-valued builder; its
 * `buildWorkflowAction` body (`output/renderers.ts` — a cycle-sensitive module)
 * is reproduced inline here rather than imported, to keep this leaf import-free
 * (only `recognition-util`, a pure sink); `tests/core/adapter/
 * akm-presentation.test.ts` pins the renderer/action values against drift.
 */

import { isKnownType, type KnownType } from "./recognition-util";

export interface Presentation {
  /** Human-readable label for this asset type (e.g. "Skill", "Knowledge"). */
  label: string;
  /**
   * Primary renderer NAME for this `type`. Optional
   * so a foreign/adapter `type` resolves to the generic fallback (no renderer)
   * instead of being forced onto one AKM owns.
   */
  renderer?: string;
  /**
   * Action-hint builder for search results. Takes the
   * item ref, returns the one-line "what to do with this hit" string.
   */
  action?: (ref: string) => string;
  /**
   * Whether a lexical Markdown fragment can replace this type's public ref.
   * Types whose advertised action consumes the whole parent stay canonical:
   * a fragment is evidence for ranking, never an executable target.
   */
  fragmentRef?: boolean;
}

/** POSIX-shell single-quote a value — inlined from `output/renderers.ts#shellQuote` (cycle-sensitive; see file header). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Reproduced from `output/renderers.ts#buildWorkflowAction` — the one function-valued `ACTION_BUILDERS.workflow` entry. */
function buildWorkflowAction(ref: string): string {
  return `Start or resume execution with \`akm workflow run ${shellQuote(ref)}\`.`;
}

/**
 * Exhaustive over {@link KnownType} — a HAND-WRITTEN literal, not derived
 * from `KNOWN_TYPES` programmatically, so the compiler rejects this object
 * if a `KNOWN_TYPES` member is added without a corresponding entry here
 * — adding a KNOWN_TYPE forces a decision.
 *
 * `renderer`/`action` are the built-in search-hit rendering data — see the
 * file header.
 */
export const TYPE_PRESENTATION: Record<KnownType, Presentation> = {
  skill: {
    label: "Skill",
    renderer: "skill-md",
    action: (ref) => `akm show ${ref} -> follow the instructions`,
    fragmentRef: false,
  },
  command: {
    label: "Command",
    renderer: "command-md",
    action: (ref) => `akm show ${ref} -> fill placeholders and dispatch`,
    fragmentRef: false,
  },
  agent: {
    label: "Agent",
    renderer: "agent-md",
    action: (ref) => `akm show ${ref} -> dispatch with full prompt`,
    fragmentRef: false,
  },
  knowledge: {
    label: "Knowledge",
    renderer: "knowledge-md",
    action: (ref) => `akm show ${ref} -> read reference material`,
  },
  workflow: {
    label: "Workflow",
    renderer: "workflow-md",
    action: (ref) => buildWorkflowAction(ref),
    fragmentRef: false,
  },
  script: {
    label: "Script",
    renderer: "script-source",
    action: (ref) => `akm show ${ref} -> execute the run command`,
    fragmentRef: false,
  },
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
      `akm show ${ref} -> name only (value never shown); akm secret run ${ref} <VAR> -- <command> -> run with value injected into $VAR`,
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
      `akm show ${ref} -> inspect; akm task run <id> -> run now; akm task enable|disable ${ref} -> change local scheduling`,
    fragmentRef: false,
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
  // doc: it REUSES
  // the `knowledge-md` renderer and mirrors knowledge's read action, so an
  // instruction hit renders exactly like knowledge instead of the generic
  // fallback (the parity guard in akm-presentation.test.ts pins this).
  instruction: {
    label: "Instruction",
    renderer: "knowledge-md",
    action: (ref) => `akm show ${ref} -> read the project instructions`,
    fragmentRef: false,
  },
};

/** Generic fallback for a type outside {@link KNOWN_TYPES} — never `undefined`, never a throw. */
const DEFAULT_PRESENTATION: Presentation = { label: "Asset" };

/**
 * Open-string lookup with a generic, non-`undefined` fallback.
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
