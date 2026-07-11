// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Dotted-path getter/setter/unsetter for AKM config objects, driven by the
 * Zod schema in `./config-schema.ts`.
 *
 * Replaces the per-key switch statement that used to live in
 * `src/commands/config-cli.ts`. Adding a new config field is now zero lines
 * of CLI code — the schema describes how to get/set/unset, and this walker
 * does the rest.
 *
 * Coercion rules for `configSet`:
 *   - z.string()           → use raw value
 *   - z.number()           → Number(value), must be finite
 *   - z.boolean()          → "true" | "false" (case-sensitive)
 *   - z.enum([...])        → must match one of the literal values
 *   - z.array(...)         → JSON-parse value, expect array, validate items
 *   - z.object({...})      → JSON-parse value, expect object, schema-validate
 *   - z.union([a,b,...])   → try each branch in order
 *   - z.record(...)        → JSON-parse value, validate
 */
import { z } from "zod";
import { UsageError } from "../errors";
import { AkmConfigBaseSchema, type AkmConfigShape, EngineConfigSchema, listTopLevelConfigKeys } from "./config-schema";
import { deepMergeConfig } from "./deep-merge";

type Path = string[];

/**
 * Parse a dotted path into segments. Empty segments are rejected. Bracket
 * notation (e.g. `sources[0]`) is NOT supported — arrays are set as JSON.
 */
function parsePath(dotted: string): Path {
  if (!dotted) {
    throw new UsageError("Config key is required.", "INVALID_FLAG_VALUE", unknownKeyHint(""));
  }
  const segments = dotted.split(".");
  if (segments.some((s) => !s)) {
    throw new UsageError(
      `Invalid config key "${dotted}": empty segment between dots.`,
      "INVALID_FLAG_VALUE",
      unknownKeyHint(dotted),
    );
  }
  return segments;
}

/** Strip Zod wrappers down to the inner schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (true) {
    if (current instanceof z.ZodOptional) {
      current = current._def.innerType;
    } else if (current instanceof z.ZodDefault) {
      current = current._def.innerType;
    } else if (current instanceof z.ZodNullable) {
      current = current._def.innerType;
    } else if (current instanceof z.ZodCatch) {
      // `.catch(...)` wraps an inner schema with a fallback value.
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      // `.refine()` / `.superRefine()` / `.transform()` / `.preprocess()` —
      // descend into the inner schema (`schema` for refine/transform, `out`
      // for preprocess — both are exposed at `_def.schema`).
      current = current._def.schema;
    } else if (current instanceof z.ZodReadonly) {
      current = current._def.innerType;
    } else {
      return current;
    }
  }
}

/**
 * Resolve the Zod schema for a given dotted path, walking from the top-level
 * AkmConfig schema. Returns `undefined` if any path segment doesn't match a
 * known schema field.
 */
function resolveSchemaAt(path: Path): z.ZodTypeAny | undefined {
  let schema: z.ZodTypeAny = AkmConfigBaseSchema;
  for (const segment of path) {
    schema = unwrap(schema);
    if (schema instanceof z.ZodObject) {
      const next = (schema.shape as Record<string, z.ZodTypeAny>)[segment];
      if (!next) {
        // Catchall (e.g. index.<passName>) — descend into the catchall schema.
        const catchall = (schema._def as { catchall?: z.ZodTypeAny }).catchall;
        if (catchall && !(catchall instanceof z.ZodNever)) {
          schema = catchall;
          continue;
        }
        return undefined;
      }
      schema = next;
    } else if (schema instanceof z.ZodRecord) {
      // Records (profiles.llm, profiles.agent, profiles.improve, sources, etc.)
      // accept any string key — descend into the value schema.
      schema = schema._def.valueType;
    } else if (schema instanceof z.ZodUnion) {
      const option = (schema._def.options as z.ZodTypeAny[]).find((candidate) => {
        const unwrapped = unwrap(candidate);
        return unwrapped instanceof z.ZodObject && segment in unwrapped.shape;
      });
      if (!option) return undefined;
      schema = (unwrap(option) as z.ZodObject<z.ZodRawShape>).shape[segment] as z.ZodTypeAny;
    } else {
      // Cannot descend into a non-object schema.
      return undefined;
    }
  }
  // Preserve leaf refinements/transforms for validation. Traversal unwraps at
  // the start of each loop iteration, while coercion unwraps independently.
  return schema;
}

/**
 * Get the value at the dotted path from a config-shaped object. Returns
 * `undefined` when the path is unset, `null` for paths that are explicitly
 * set to `null`.
 */
export function configGet(config: Record<string, unknown>, dotted: string): unknown {
  const path = parsePath(dotted);
  const schema = resolveSchemaAt(path);
  if (!schema) {
    throw new UsageError(`Unknown config key: ${dotted}`, "INVALID_FLAG_VALUE", unknownKeyHint(dotted));
  }
  let cursor: unknown = config;
  for (const segment of path) {
    if (cursor === null || cursor === undefined) return null;
    if (typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor ?? null;
}

/**
 * Set the value at the dotted path. Coerces `raw` according to the schema at
 * that path. Returns a new config object — the input is not mutated.
 *
 * Throws {@link UsageError} on:
 *   - unknown path
 *   - invalid apiKey paths
 *   - coercion failure
 */
export function configSet(config: Record<string, unknown>, dotted: string, raw: string): Record<string, unknown> {
  const path = parsePath(dotted);
  if (path.length === 1 && path[0] === "configVersion") {
    throw new UsageError("configVersion cannot be changed through config set.", "INVALID_FLAG_VALUE");
  }

  // #454: apiKey paths are not persistable. Throw at set time.
  rejectApiKeyPath(path, dotted);

  const schema = resolveSchemaAt(path);
  const symbolicApiKey =
    (path[0] === "engines" && path[2] === "apiKey") ||
    (path[0] === "embedding" && path.length === 2 && path[1] === "apiKey");
  if (!schema && !symbolicApiKey) {
    throw new UsageError(`Unknown config key: ${dotted}`, "INVALID_FLAG_VALUE", unknownKeyHint(dotted));
  }

  const value =
    path[0] === "engines" && path.length === 2
      ? parseObjectPatch(raw, dotted)
      : symbolicApiKey
        ? raw
        : coerceForSchema(schema as z.ZodTypeAny, raw, dotted);

  // Validate the coerced value against the leaf schema. This catches enum
  // mismatches, out-of-range numbers, schema-level shape errors (writable
  // npm/website sources via .superRefine, strict-mode unknown keys in nested
  // objects, etc.) BEFORE we apply the patch.
  const parsed =
    path[0] === "engines" && path.length === 2
      ? EngineConfigSchema.safeParse(value)
      : symbolicApiKey
        ? /^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(raw)
          ? { success: true as const, data: value }
          : { success: false as const, error: { issues: [{ path: [], message: `apiKey must be $VAR or \${VAR}` }] } }
        : (schema as z.ZodTypeAny).safeParse(value);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? `${dotted}.${i.path.join(".")}` : dotted;
        return `  - ${path}: ${i.message}`;
      })
      .join("\n");
    throw new UsageError(`Invalid value for ${dotted}:\n${lines}`, "INVALID_FLAG_VALUE");
  }

  const existing = path.reduce<unknown>((value, key) => {
    if (value && typeof value === "object") return (value as Record<string, unknown>)[key];
    return undefined;
  }, config);
  const next = setPath(
    config,
    path,
    isPlainObject(existing) && isPlainObject(parsed.data) ? deepMergeConfig(existing, parsed.data) : parsed.data,
  );

  // Targeted invariant: defaultWriteTarget must point at a configured source
  // (#464.a). Whole-config validation happens at save time; this check fires
  // at set time so the user sees the typo immediately. Empty-sources case is
  // accepted here (legacy behaviour) — saveConfig will reject if it persists.
  if (dotted === "defaultWriteTarget" && typeof value === "string") {
    const sources = (next.sources as Array<{ name?: string }> | undefined) ?? [];
    const knownNames = sources.map((s) => s.name).filter((n): n is string => typeof n === "string" && n.length > 0);
    if (knownNames.length > 0 && !knownNames.includes(value)) {
      throw new UsageError(
        `Unknown source name "${value}" for defaultWriteTarget; configured source names: ${knownNames.map((n) => `"${n}"`).join(", ")}.`,
        "INVALID_FLAG_VALUE",
      );
    }
  }

  return next;
}

/**
 * Unset the value at the dotted path. Removes the leaf key (and prunes empty
 * parent objects if they become empty). Returns a new config object.
 */
export function configUnset(config: Record<string, unknown>, dotted: string): Record<string, unknown> {
  const path = parsePath(dotted);
  if (path.length === 1 && path[0] === "configVersion") {
    throw new UsageError("configVersion cannot be removed through config unset.", "INVALID_FLAG_VALUE");
  }
  // Validate the path resolves to a real schema field (so typos don't no-op).
  const schema = resolveSchemaAt(path);
  if (!schema) {
    throw new UsageError(`Unknown config key: ${dotted}`, "INVALID_FLAG_VALUE", unknownKeyHint(dotted));
  }
  return unsetPath(config, path);
}

// ── apiKey rejection (#454) ─────────────────────────────────────────────────

/**
 * Embedding credentials are never persisted. Engine credentials are symbolic
 * configuration and are validated by the engine schema below.
 */
function rejectApiKeyPath(path: Path, dotted: string): void {
  if (path[0] === "engines" && path[2] === "apiKey") return;
  if (path[0] === "embedding" && path.length === 2 && path[1] === "apiKey") return;
  const last = path[path.length - 1];
  if (last !== "apiKey") return;
  const recipe = recipeForApiKey(path, dotted);
  throw new UsageError(
    `apiKey cannot be persisted in config; export ${recipe} instead. (key: ${dotted})`,
    "INVALID_FLAG_VALUE",
    "Storing API keys in config.json leaks them through backups, logs, and version control. " +
      "Use the corresponding environment variable. AKM reads it at request time.",
  );
}

function parseObjectPatch(raw: string, key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    if (!isPlainObject(value)) throw new Error("expected an object");
    return value;
  } catch (err) {
    throw new UsageError(
      `Invalid JSON object for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_JSON_CONFIG_VALUE",
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recipeForApiKey(path: Path, _dotted: string): string {
  if (path[0] === "embedding") return "AKM_EMBED_API_KEY";
  if (path[0] === "engines" && typeof path[1] === "string") {
    return `AKM_ENGINE_${path[1].toUpperCase().replaceAll("-", "_")}_API_KEY`;
  }
  return "AKM_LLM_API_KEY / AKM_EMBED_API_KEY";
}

// ── Coercion ────────────────────────────────────────────────────────────────

/**
 * Coerce a CLI string into the value expected by the given schema. JSON-object
 * and JSON-array schemas accept either a JSON literal or the string `null`/
 * empty (which clears the value, equivalent to unset).
 */
function coerceForSchema(schema: z.ZodTypeAny, raw: string, key: string): unknown {
  const target = unwrap(schema);

  if (target instanceof z.ZodString) {
    return raw;
  }
  if (target instanceof z.ZodNumber) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new UsageError(`Invalid value for ${key}: expected a number, got "${raw}".`);
    }
    return n;
  }
  if (target instanceof z.ZodBoolean) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new UsageError(`Invalid value for ${key}: expected true or false, got "${raw}".`);
  }
  if (target instanceof z.ZodEnum) {
    return raw;
  }
  if (target instanceof z.ZodLiteral) {
    return target._def.value;
  }
  if (target instanceof z.ZodArray || target instanceof z.ZodObject || target instanceof z.ZodRecord) {
    if (raw === "" || raw === "null") return undefined;
    try {
      return JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new UsageError(`Invalid JSON for ${key}: ${detail}`, "INVALID_JSON_CONFIG_VALUE");
    }
  }
  if (target instanceof z.ZodUnion) {
    // Try each option in order. Use the first that the schema accepts after
    // coercion. Falls through to JSON parsing if all fail.
    const options = target._def.options as z.ZodTypeAny[];
    let lastErr: unknown;
    for (const opt of options) {
      try {
        const coerced = coerceForSchema(opt, raw, key);
        const parsed = opt.safeParse(coerced);
        if (parsed.success) return parsed.data;
        lastErr = parsed.error;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr instanceof Error) throw new UsageError(`Invalid value for ${key}: ${lastErr.message}`);
    throw new UsageError(`Invalid value for ${key}: did not match any expected type.`);
  }
  if (target instanceof z.ZodNull) {
    if (raw === "" || raw === "null") return null;
    throw new UsageError(`Invalid value for ${key}: expected null.`);
  }
  // Fallback: try JSON parse, then raw string.
  if (raw === "" || raw === "null") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ── Path mutators ───────────────────────────────────────────────────────────

function setPath(config: Record<string, unknown>, path: Path, value: unknown): Record<string, unknown> {
  if (path.length === 0) return config;
  const [head, ...rest] = path;
  const next = { ...config };
  if (rest.length === 0) {
    if (value === undefined) {
      delete next[head];
    } else {
      next[head] = value;
    }
    return next;
  }
  const existing = next[head];
  const child =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  next[head] = setPath(child, rest, value);
  return next;
}

function unsetPath(config: Record<string, unknown>, path: Path): Record<string, unknown> {
  if (path.length === 0) return config;
  const [head, ...rest] = path;
  const next = { ...config };
  if (rest.length === 0) {
    delete next[head];
    return next;
  }
  const existing = next[head];
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    return next; // nothing to unset
  }
  const updated = unsetPath(existing as Record<string, unknown>, rest);
  if (Object.keys(updated).length === 0) {
    delete next[head];
  } else {
    next[head] = updated;
  }
  return next;
}

// ── Hint generation (#460) ──────────────────────────────────────────────────

export function unknownKeyHint(_attempted: string): string {
  const keys = listTopLevelConfigKeys();
  return `Valid top-level keys: ${keys.join(", ")}. Use dotted paths for nested values (e.g. embedding.endpoint, engines.<name>.model).`;
}

// ── Re-exports for the CLI ──────────────────────────────────────────────────

// Marker type — useful to document the contract at call sites without re-deriving.
export type { AkmConfigShape };
