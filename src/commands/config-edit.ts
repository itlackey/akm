// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Interactive `akm config edit` — a schema-driven, menu-based config editor.
 *
 * ## Why @clack/prompts (not a widget TUI)
 *
 * The issue (#513) originally proposed a `neo-blessed` BIOS-style widget TUI.
 * After evaluation (see `docs/technical/ink-tui-evaluation.md` and the #513
 * comments) we ship this on `@clack/prompts` — the prompt library akm already
 * uses for `akm setup` and `confirmDestructive`. Zero new deps, the same
 * interaction paradigm as setup, and a proven packaging path through the
 * `bun build --compile` single binary.
 *
 * ## Schema-driven, single source of truth
 *
 * The section list, the per-section fields, and each field's input type are
 * DERIVED from the Zod config schema (`core/config/config-schema.ts`) by
 * {@link buildConfigEditModel}. There is no hand-maintained parallel field
 * table — adding a field to the schema makes it appear in the editor for free.
 *
 * ## Reuse, don't reimplement
 *
 * The write path reuses the existing machinery verbatim:
 *   - {@link setConfigValue} (the config-cli walker front-end) for coercion,
 *     validation, legacy aliasing, and apiKey rejection.
 *   - {@link loadConfig} / {@link saveConfig} for read/write.
 *   - {@link backupExistingConfig} for the timestamped pre-write snapshot.
 *
 * ## Pure core, thin shell
 *
 * {@link buildConfigEditModel} and {@link applyConfigEdit} are pure and unit
 * tested directly — no TTY required. {@link runConfigEdit} is the thin
 * @clack interaction layer.
 */

import * as p from "@clack/prompts";
import { z } from "zod";
import { type AkmConfig, loadConfig, saveConfig } from "../core/config/config";
import { backupExistingConfig } from "../core/config/config-io";
import { AkmConfigShape } from "../core/config/config-schema";
import { UsageError } from "../core/errors";
import { getConfigPath } from "../core/paths";
import { getConfigValue, setConfigValue } from "./config-cli";

// ── Edit model (pure, schema-derived) ────────────────────────────────────────

/** How a leaf field is prompted for in the interactive editor. */
export type ConfigFieldKind = "text" | "number" | "boolean" | "select" | "secret" | "json";

export interface ConfigEditField {
  /** Dotted path used with `getConfigValue` / `setConfigValue`. */
  path: string;
  /** Leaf segment, shown as the field label. */
  label: string;
  /** Input kind, derived from the schema at this path. */
  kind: ConfigFieldKind;
  /** For `kind === "select"`: the allowed enum values. */
  options?: string[];
  /**
   * True when the field is an apiKey/secret that must NOT be persisted to
   * config (#454). The editor shows env-var guidance instead of writing.
   */
  secret: boolean;
}

export interface ConfigEditSection {
  /** Top-level config key (e.g. `embedding`, `search`). */
  key: string;
  /** Editable leaf fields within this section. */
  fields: ConfigEditField[];
}

export interface ConfigEditModel {
  sections: ConfigEditSection[];
}

/** Maximum nesting depth walked when deriving fields. Guards against records. */
const MAX_FIELD_DEPTH = 3;

/** Strip Zod wrappers (.optional/.default/.nullable/.catch/.effects). */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional) current = current._def.innerType;
    else if (current instanceof z.ZodDefault) current = current._def.innerType;
    else if (current instanceof z.ZodNullable) current = current._def.innerType;
    else if (current instanceof z.ZodCatch) current = current._def.innerType;
    else if (current instanceof z.ZodReadonly) current = current._def.innerType;
    else if (current instanceof z.ZodEffects) current = current._def.schema;
    else return current;
  }
}

/** Classify an unwrapped leaf schema into a {@link ConfigFieldKind}. */
function classifyLeaf(schema: z.ZodTypeAny, isSecret: boolean): ConfigEditField["kind"] | null {
  if (isSecret) return "secret";
  if (schema instanceof z.ZodString) return "text";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return "select";
  // ZodNativeEnum / ZodLiteral are treated as select/text fallbacks.
  if (schema instanceof z.ZodLiteral) return "text";
  // Unions of primitives (e.g. configVersion: string|number) → text.
  if (schema instanceof z.ZodUnion) {
    const opts = (schema._def.options as z.ZodTypeAny[]).map(unwrapSchema);
    if (opts.some((o) => o instanceof z.ZodString || o instanceof z.ZodNumber)) return "text";
  }
  return null;
}

/**
 * Recursively collect editable leaf fields from an object schema. Descends
 * into nested `z.object(...)` shapes (building dotted paths); records, arrays,
 * and unknown composites are surfaced as a single `json` field so the user can
 * still edit them as raw JSON via the walker's JSON coercion path.
 */
function collectFields(schema: z.ZodTypeAny, prefix: string, depth: number): ConfigEditField[] {
  const unwrapped = unwrapSchema(schema);
  const fields: ConfigEditField[] = [];

  if (unwrapped instanceof z.ZodObject && depth < MAX_FIELD_DEPTH) {
    const shape = unwrapped.shape as Record<string, z.ZodTypeAny>;
    for (const [key, child] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const childUnwrapped = unwrapSchema(child);
      const isSecret = key === "apiKey";

      if (childUnwrapped instanceof z.ZodObject && depth + 1 < MAX_FIELD_DEPTH) {
        fields.push(...collectFields(childUnwrapped, path, depth + 1));
        continue;
      }

      const kind = classifyLeaf(childUnwrapped, isSecret);
      if (kind === null) {
        // Records / arrays / nested composites at the depth limit: editable as JSON.
        if (
          childUnwrapped instanceof z.ZodRecord ||
          childUnwrapped instanceof z.ZodArray ||
          childUnwrapped instanceof z.ZodObject
        ) {
          fields.push({ path, label: key, kind: "json", secret: false });
        }
        continue;
      }
      const field: ConfigEditField = {
        path,
        label: key,
        kind,
        secret: kind === "secret",
      };
      if (kind === "select") {
        field.options = [...(childUnwrapped._def.values as readonly string[])];
      }
      fields.push(field);
    }
  }

  return fields;
}

/**
 * Build the schema-driven edit model: one section per top-level config key,
 * each with its editable leaf fields and input kinds. Pure — depends only on
 * the schema (the `config` argument is reserved for future value-aware
 * shaping; current callers pass it through unchanged for symmetry with
 * {@link applyConfigEdit}).
 *
 * Sections that yield no editable fields (pure records/arrays like `sources`,
 * `installed`, `registries`, `index`, `profiles`) are still surfaced with a
 * single `json` field so they remain reachable in the menu.
 */
export function buildConfigEditModel(
  shape: typeof AkmConfigShape = AkmConfigShape,
  _config?: AkmConfig,
): ConfigEditModel {
  const sections: ConfigEditSection[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    const unwrapped = unwrapSchema(schema as z.ZodTypeAny);
    let fields: ConfigEditField[];

    if (unwrapped instanceof z.ZodObject) {
      fields = collectFields(unwrapped, key, 1);
      if (fields.length === 0) {
        fields = [{ path: key, label: key, kind: "json", secret: false }];
      }
    } else {
      const kind = classifyLeaf(unwrapped, false);
      if (kind) {
        const field: ConfigEditField = { path: key, label: key, kind, secret: false };
        if (kind === "select") field.options = [...(unwrapped._def.values as readonly string[])];
        fields = [field];
      } else {
        // Arrays / records / unknown top-level shapes → editable as JSON.
        fields = [{ path: key, label: key, kind: "json", secret: false }];
      }
    }

    sections.push({ key, fields });
  }
  return sections.length > 0 ? { sections } : { sections: [] };
}

// ── Apply (pure write delegation) ────────────────────────────────────────────

/**
 * Apply a single edit to a config object, returning the next config. Pure —
 * delegates to {@link setConfigValue} (the existing walker front-end), so it
 * inherits coercion, schema validation, legacy aliasing, AND the apiKey
 * rejection guard (#454). Callers must NOT pass apiKey paths; the editor shell
 * routes secrets to env-var guidance and never reaches here for them.
 *
 * @throws UsageError on apiKey paths, unknown keys, or invalid values.
 */
export function applyConfigEdit(config: AkmConfig, path: string, value: string): AkmConfig {
  return setConfigValue(config, path, value);
}

/** Environment variable a secret field steers the user toward (#454). */
export function envVarForSecret(path: string): string {
  if (path === "embedding.apiKey") return "AKM_EMBED_API_KEY";
  if (path === "llm.apiKey") return "AKM_LLM_API_KEY";
  if (path.startsWith("profiles.llm.")) return "AKM_LLM_API_KEY";
  return "AKM_LLM_API_KEY / AKM_EMBED_API_KEY";
}

// ── Interactive shell (thin @clack layer) ────────────────────────────────────

/**
 * Determine whether the current process can run an interactive editor.
 * Requires a real TTY on both stdin and stdout and a non-CI environment.
 */
export function isInteractiveTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI;
  const isCi = ci !== undefined && ci !== null && !["", "0", "false"].includes(String(ci).trim().toLowerCase());
  if (isCi) return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

const NON_INTERACTIVE_MESSAGE =
  "`akm config edit` is interactive and requires a TTY. " +
  "Use `akm config set <key> <value>` for scripted or CI edits.";

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(unset)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Run the interactive config editor. Throws {@link UsageError} when no TTY is
 * available (CI / piped). Otherwise drives a menu loop:
 *   section select → field select → typed value prompt → confirm → backup+save.
 */
export async function runConfigEdit(): Promise<void> {
  if (!isInteractiveTerminal()) {
    throw new UsageError(NON_INTERACTIVE_MESSAGE, "NON_INTERACTIVE_REQUIRES_YES");
  }

  let config = loadConfig();
  const model = buildConfigEditModel(AkmConfigShape, config);
  let dirty = false;

  p.intro("akm config edit");

  for (;;) {
    const sectionKey = await p.select({
      message: "Select a config section to edit:",
      options: [
        ...model.sections.map((s) => ({ value: s.key, label: s.key })),
        { value: "__exit__", label: dirty ? "Save and exit" : "Exit" },
      ],
    });
    if (p.isCancel(sectionKey) || sectionKey === "__exit__") break;

    const section = model.sections.find((s) => s.key === sectionKey);
    if (!section) continue;

    const fieldPath = await p.select({
      message: `Select a field in "${section.key}":`,
      options: [
        ...section.fields.map((f) => ({
          value: f.path,
          label: f.label,
          hint: `${f.kind} — ${formatValue(safeGet(config, f.path))}`,
        })),
        { value: "__back__", label: "← Back" },
      ],
    });
    if (p.isCancel(fieldPath) || fieldPath === "__back__") continue;

    const field = section.fields.find((f) => f.path === fieldPath);
    if (!field) continue;

    // #454: never persist secrets. Show env-var guidance and skip the write.
    if (field.secret) {
      p.note(
        `API keys are never stored in config (they leak through backups, logs, and version control).\n` +
          `Export the environment variable instead:\n\n  export ${envVarForSecret(field.path)}=…\n\n` +
          `AKM reads it at request time.`,
        "apiKey is not persisted",
      );
      continue;
    }

    const newValue = await promptForField(field, safeGet(config, field.path));
    if (newValue === undefined) continue; // cancelled / back

    try {
      config = applyConfigEdit(config, field.path, newValue);
      dirty = true;
      p.log.success(`Set ${field.path} = ${newValue}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.log.error(msg);
    }
  }

  if (!dirty) {
    p.outro("No changes made.");
    return;
  }

  const confirmed = await p.confirm({ message: "Save changes to config?", initialValue: true });
  if (p.isCancel(confirmed) || confirmed !== true) {
    p.outro("Discarded changes.");
    return;
  }

  const backup = backupExistingConfig(getConfigPath());
  saveConfig(config);
  if (backup) {
    p.outro(`Saved. Backup written to ${backup.timestamped}`);
  } else {
    p.outro("Saved.");
  }
}

/** Read a value via the existing walker front-end, swallowing unknown-key errors. */
function safeGet(config: AkmConfig, path: string): unknown {
  try {
    return getConfigValue(config, path);
  } catch {
    return undefined;
  }
}

/**
 * Prompt for a single field's new value, typed by its schema-derived kind.
 * Returns the raw string to pass to {@link applyConfigEdit}, or `undefined`
 * when the user cancels.
 */
async function promptForField(field: ConfigEditField, current: unknown): Promise<string | undefined> {
  if (field.kind === "boolean") {
    const v = await p.confirm({
      message: `${field.label}:`,
      initialValue: current === true,
    });
    if (p.isCancel(v)) return undefined;
    return v ? "true" : "false";
  }

  if (field.kind === "select" && field.options) {
    const v = await p.select({
      message: `${field.label}:`,
      options: field.options.map((o) => ({ value: o, label: o })),
      initialValue: typeof current === "string" ? current : undefined,
    });
    if (p.isCancel(v)) return undefined;
    return v;
  }

  const placeholder = field.kind === "json" ? "JSON value (or empty to clear)" : "";
  const initial =
    current === null || current === undefined
      ? ""
      : typeof current === "object"
        ? JSON.stringify(current)
        : String(current);
  const v = await p.text({
    message: `${field.label}${field.kind === "number" ? " (number)" : ""}:`,
    placeholder,
    initialValue: initial,
  });
  if (p.isCancel(v)) return undefined;
  return v;
}
