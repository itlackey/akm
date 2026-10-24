// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The bounded-document front end and field helpers both task source grammars
 * share (spec docs/plans/specs/p2a-task-source-v4.md §1.5 D2-N4, §3.1).
 *
 * This is the actual D2-N4 move, not a parallel reimplementation: every
 * helper below — including the `TASK_V3_MAX_*` resource bounds and
 * `assertBoundedTaskYamlDocument` — is now OWNED here, body-intact from
 * `src/tasks/source-v3.ts`. `source-v3.ts` imports every one of them (and
 * re-exports `assertBoundedTaskYamlDocument` / the `TASK_V3_MAX_*` constants
 * at their existing names, since those were already part of its public
 * surface) instead of declaring its own copies. §9's acceptance criterion is
 * structural: "src/tasks/source/bounded-document.ts exists and owns the
 * D2-N4 helpers; src/tasks/source-v3.ts imports them and contains no copy of
 * any of them" — `tests/tasks/bounded-document.test.ts`'s last describe
 * block pins this with an AST scan of `source-v3.ts`, not just a runtime
 * behavior check (a copy-instead-of-move implementation would pass every
 * OTHER test in that file and in `tests/tasks/source-v3.test.ts`, because
 * both files would still call functions they have in scope either way).
 *
 * This module deliberately imports NOTHING from `../source-v3` (not even a
 * type) — `tests/architecture/import-cycle-ratchet.test.ts` is an ABSOLUTE
 * no-cycle gate over all of `src/**` (its baseline emptied at chunk-8 and
 * counts type-only imports as real graph edges), and `source-v3.ts` now
 * imports from this file, so a reverse edge here would close a cycle. Where
 * a moved helper's signature referenced a v3-only type
 * (`TaskV3AkmOptions["tools"]`, `TaskV3Environment`) the return type is
 * inlined structurally instead — invisible at runtime, and TypeScript's
 * structural typing makes the inlined shape and the named alias
 * interchangeable at every call site.
 *
 * `parseTimeout` and `parseTools` stay v3-only in the sense that they
 * hardcode the `["akm", …]` field path (byte-identical to v3's existing
 * behavior — that hardcoding is exactly what D2-N4's binding resolution asks
 * to preserve). Task source v4's top-level `timeout:`/`tools:` fields have
 * their own siblings in `src/tasks/source/task-source-v4.ts`
 * (`parseTimeoutTopLevel`/`parseToolsTopLevel`) with the same accept/reject
 * semantics at a different, un-prefixed field path — v3 imports the two
 * below rather than declaring them itself, purely because D2-N4 homes every
 * one of these named helpers here. `nullableSelector` is the same kind of
 * `["akm", …]`-hardcoding helper but is NOT in D2-N4's named list and stays
 * declared directly in `source-v3.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { wellFormedUnicode } from "../../core/common";
import { UsageError } from "../../core/errors";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../execution/limits";
import { type StrictRecordSnapshot, snapshotStrictRecord } from "../../execution/record";
import { WORKFLOW_ENV_VAR_NAME_PATTERN } from "../../workflows/resource-limits";

// ── Resource bounds (D2-N4: owned here, re-exported by source-v3.ts) ───────

export const TASK_V3_MAX_JSON_DEPTH = 64;
export const TASK_V3_MAX_JSON_NODES = 10_000;
export const TASK_V3_MAX_COLLECTION_ITEMS = 1024;
export const TASK_V3_MAX_OBJECT_KEYS = 256;
export const TASK_V3_MAX_STRING_BYTES = 256 * 1024;
export const TASK_V3_MAX_SCHEDULES = 64;
/** Max entries in a task's `redact:` env-name list. */
export const TASK_V3_MAX_REDACT_NAMES = 32;

/** Parse context every helper in this module takes. `workspaceRoot` is used only by {@link validateWorkingDirectory}. */
export interface BoundedDocumentContext {
  readonly filePath: string;
  /**
   * The text substituted into `Invalid <sourceLabel> at <path>: …` — the ONLY
   * text that differs between callers. P4 (docs/plans/specs/p4-deletions-closeout.md
   * §3.2) deleted task v3 acceptance from `src`, so the "task v3 source"
   * label this field once carried no longer has a live caller here; today's
   * two values are `"task source v4"` (`task-source-v4.ts`'s `SOURCE_LABEL`)
   * and `"task source"` (the version router, `parse-task-source.ts`, whose
   * front end runs before `root.version` is read).
   */
  readonly sourceLabel: string;
  readonly workspaceRoot?: string;
  readonly lineAt?: (fieldPath: readonly (string | number)[]) => number | undefined;
}

interface CloneState {
  nodes: number;
}

export function own(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** The one per-field error funnel both grammars render through, distinguished only by `ctx.sourceLabel` (D2-N4). */
export function sourceError(
  ctx: Pick<BoundedDocumentContext, "filePath" | "sourceLabel" | "lineAt">,
  fieldPath: readonly (string | number)[],
  detail: string,
): never {
  const dotted =
    fieldPath.length === 0
      ? "$"
      : fieldPath.reduce<string>(
          (display, segment) =>
            typeof segment === "number"
              ? `${display}[${segment}]`
              : display.length > 0
                ? `${display}.${segment}`
                : segment,
          "",
        );
  const line = ctx.lineAt?.(fieldPath);
  const location = `${ctx.filePath}${line === undefined ? "" : `:${line}`}`;
  throw new UsageError(`Invalid ${ctx.sourceLabel} at ${location}: ${dotted} ${detail}`, "TASK_SOURCE_INVALID");
}

export function cloneBoundedJson(
  value: unknown,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
  state: CloneState,
  depth = 0,
  ancestors: ReadonlySet<object> = new Set(),
): ExecutionJsonValue {
  state.nodes += 1;
  if (state.nodes > TASK_V3_MAX_JSON_NODES)
    sourceError(ctx, fieldPath, `exceeds the ${TASK_V3_MAX_JSON_NODES}-node limit.`);
  if (depth > TASK_V3_MAX_JSON_DEPTH)
    sourceError(ctx, fieldPath, `exceeds the nesting depth of ${TASK_V3_MAX_JSON_DEPTH}.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) sourceError(ctx, fieldPath, "must be a finite JSON number.");
    return value;
  }
  if (typeof value === "string") {
    if (!wellFormedUnicode(value)) sourceError(ctx, fieldPath, "must contain well-formed Unicode.");
    if (utf8Bytes(value) > TASK_V3_MAX_STRING_BYTES) {
      sourceError(ctx, fieldPath, `exceeds the ${TASK_V3_MAX_STRING_BYTES}-byte string limit.`);
    }
    return value;
  }
  if (value === undefined) sourceError(ctx, fieldPath, "must be omitted instead of set to undefined.");
  if (typeof value !== "object") sourceError(ctx, fieldPath, "must be JSON-safe.");
  if (utilTypes.isProxy(value)) sourceError(ctx, fieldPath, "must not be a Proxy object.");
  if (ancestors.has(value)) sourceError(ctx, fieldPath, "must not contain a cycle.");
  const nextAncestors = new Set(ancestors).add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      sourceError(ctx, fieldPath, "array must use the standard prototype.");
    const rawLength = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
    if (
      typeof rawLength !== "number" ||
      !Number.isInteger(rawLength) ||
      rawLength < 0 ||
      rawLength > TASK_V3_MAX_COLLECTION_ITEMS
    ) {
      sourceError(ctx, fieldPath, `array exceeds the ${TASK_V3_MAX_COLLECTION_ITEMS}-item limit.`);
    }
    const length = rawLength as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) sourceError(ctx, fieldPath, "array must be dense and contain no extra fields.");
    const result: ExecutionJsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        sourceError(ctx, [...fieldPath, index], "array item must be an enumerable data property in a dense array.");
      }
      result.push(cloneBoundedJson(descriptor.value, ctx, [...fieldPath, index], state, depth + 1, nextAncestors));
    }
    return Object.freeze(result);
  }

  let snapshot: StrictRecordSnapshot;
  try {
    snapshot = snapshotStrictRecord(value, fieldPath.map(String).join(".") || "task source");
  } catch (cause) {
    sourceError(ctx, fieldPath, cause instanceof Error ? cause.message : String(cause));
  }
  const entries = Object.entries(snapshot);
  if (entries.length > TASK_V3_MAX_OBJECT_KEYS) {
    sourceError(ctx, fieldPath, `mapping exceeds the ${TASK_V3_MAX_OBJECT_KEYS}-key limit.`);
  }
  const result = Object.create(null) as Record<string, ExecutionJsonValue>;
  for (const [key, child] of entries) {
    if (!wellFormedUnicode(key)) sourceError(ctx, fieldPath, "contains a mapping key with malformed Unicode.");
    if (utf8Bytes(key) > TASK_V3_MAX_STRING_BYTES) {
      sourceError(
        ctx,
        fieldPath,
        `contains a mapping key exceeding the ${TASK_V3_MAX_STRING_BYTES}-byte string limit.`,
      );
    }
    Object.defineProperty(result, key, {
      value: cloneBoundedJson(child, ctx, [...fieldPath, key], state, depth + 1, nextAncestors),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result);
}

export function asRecord(
  value: ExecutionJsonValue,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
): ExecutionJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    sourceError(ctx, fieldPath, "must be a mapping.");
  return value as ExecutionJsonObject;
}

export function checkKeys(
  value: ExecutionJsonObject,
  allowed: readonly string[],
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
): void {
  const allow = new Set(allowed);
  const firstUnknown = Object.keys(value).find((key) => !allow.has(key));
  if (firstUnknown !== undefined) sourceError(ctx, [...fieldPath, firstUnknown], "is an unsupported field.");
}

export function presentJsonValue(
  value: ExecutionJsonValue | undefined,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
): ExecutionJsonValue {
  if (value === undefined) sourceError(ctx, fieldPath, "must be omitted instead of set to undefined.");
  return value;
}

export function stringField(
  value: unknown,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
  options: { nonempty?: boolean; nullable?: boolean } = {},
): string | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== "string")
    sourceError(ctx, fieldPath, options.nullable ? "must be a string or null." : "must be a string.");
  if (options.nonempty && value.trim().length === 0) sourceError(ctx, fieldPath, "must be a non-empty string.");
  return value;
}

export function noGithubExpression(
  value: string,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
): void {
  if (value.includes("${{")) sourceError(ctx, fieldPath, "contains an unsupported GitHub expression.");
}

/** `env:` is already a top-level field in both grammars — reused body-intact, field path unchanged. */
export function parseEnvironment(
  value: ExecutionJsonValue,
  ctx: BoundedDocumentContext,
): Readonly<Record<string, string | number | boolean>> {
  const environment = asRecord(value, ctx, ["env"]);
  for (const [key, child] of Object.entries(environment)) {
    if (!WORKFLOW_ENV_VAR_NAME_PATTERN.test(key))
      sourceError(ctx, ["env", key], "has an invalid environment variable name.");
    if (typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") {
      sourceError(ctx, ["env", key], "must be a string, finite number, or boolean.");
    }
  }
  return environment as Readonly<Record<string, string | number | boolean>>;
}

export function parseStringArray(
  value: unknown,
  ctx: BoundedDocumentContext,
  fieldPath: readonly (string | number)[],
  options: { max?: number; pattern?: RegExp } = {},
): readonly string[] {
  if (!Array.isArray(value)) sourceError(ctx, fieldPath, "must be an array of strings.");
  if (options.max !== undefined && value.length > options.max)
    sourceError(ctx, fieldPath, `accepts at most ${options.max} items.`);
  const strings: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0)
      sourceError(ctx, [...fieldPath, index], "must be a non-empty string.");
    if (options.pattern && !options.pattern.test(entry))
      sourceError(ctx, [...fieldPath, index], "has an invalid value.");
    strings.push(entry);
  }
  return Object.freeze(strings);
}

/**
 * `akm.timeout` — v3-only (hardcodes the `["akm", "timeout"]` field path, see
 * this module's header). Body-intact from `source-v3.ts`.
 */
export function parseTimeout(value: unknown, ctx: BoundedDocumentContext): string | number | null {
  if (value === null) return null;
  if (typeof value === "string" && value.trim() !== value) {
    sourceError(ctx, ["akm", "timeout"], "must not contain surrounding whitespace.");
  }
  const milliseconds = typeof value === "string" ? parseDuration(value, DURATION_UNITS) : value;
  if (
    milliseconds === null ||
    typeof milliseconds !== "number" ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > EXECUTION_MAX_TIMEOUT_MS
  ) {
    sourceError(
      ctx,
      ["akm", "timeout"],
      `must be null, 0 through ${EXECUTION_MAX_TIMEOUT_MS} milliseconds, or a common duration such as 20m.`,
    );
  }
  return value as string | number;
}

/**
 * `akm.tools` — v3-only (hardcodes the `["akm", "tools"]` field path, see
 * this module's header). Body-intact from `source-v3.ts`; the return type is
 * inlined (was `TaskV3AkmOptions["tools"]`) so this module imports nothing
 * from `../source-v3` (see header — the import-cycle ratchet is absolute).
 */
export function parseTools(
  value: ExecutionJsonValue,
  ctx: BoundedDocumentContext,
): string | readonly string[] | ExecutionJsonObject | null {
  if (value === null || typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== "string"))
      sourceError(ctx, ["akm", "tools"], "array values must be strings.");
    return value as readonly string[];
  }
  if (typeof value === "object") return value as ExecutionJsonObject;
  sourceError(ctx, ["akm", "tools"], "must be a string, string array, mapping, or null.");
}

/**
 * `working-directory:` is already a top-level field in both grammars —
 * reused body-intact, field path unchanged (`source-v3.ts:677-714`).
 */
export function validateWorkingDirectory(value: string, ctx: BoundedDocumentContext): void {
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value.replaceAll("\\", "/")) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  ) {
    sourceError(ctx, ["working-directory"], "must be a non-empty relative path contained by the workspace root.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === ".." || segment.length === 0)) {
    sourceError(ctx, ["working-directory"], "must not contain empty or escaping path segments.");
  }
  if (!ctx.workspaceRoot) {
    sourceError(ctx, ["working-directory"], "requires a workspace root so physical containment can be verified.");
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = fs.realpathSync(ctx.workspaceRoot);
    const candidate = path.resolve(realRoot, value);
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) sourceError(ctx, ["working-directory"], "must resolve to a directory.");
    realCandidate = fs.realpathSync(candidate);
  } catch (cause) {
    if (cause instanceof UsageError) throw cause;
    sourceError(
      ctx,
      ["working-directory"],
      `cannot be physically verified: ${cause instanceof Error ? cause.message : String(cause)}.`,
    );
  }
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sourceError(ctx, ["working-directory"], "resolves outside the workspace root and is not physically contained.");
  }
}

export function yamlProblem(message: string): string {
  return message.split("\n")[0]?.trim() || "invalid YAML";
}

// ── The bounded YAML front end ──────────────────────────────────────────────

export interface BoundedTaskSourceYamlInput {
  readonly yaml: string;
  readonly filePath: string;
}

export interface BoundedTaskSourceYamlResult {
  readonly root: unknown;
  readonly lineAt: (fieldPath: readonly (string | number)[]) => number | undefined;
}

export interface BoundedTaskYamlOptions {
  readonly filePath: string;
  readonly sourceLabel: string;
  readonly lineCounter?: LineCounter;
}

export function yamlAstError(options: BoundedTaskYamlOptions, node: unknown, detail: string): never {
  const range = (node as { range?: readonly number[] | null } | null | undefined)?.range;
  const line = range && options.lineCounter ? options.lineCounter.linePos(range[0] ?? 0).line : undefined;
  throw new UsageError(
    `Invalid ${options.sourceLabel} at ${options.filePath}${line === undefined ? "" : `:${line}`}: ${detail}`,
    "TASK_SOURCE_INVALID",
  );
}

/**
 * Bound and close the YAML AST before `toJS` can allocate or recurse through
 * it. This is shared by the v3 parser, task source v4, and the explicit v2
 * migration reader.
 */
export function assertBoundedTaskYamlDocument(
  document: ReturnType<typeof parseDocument>,
  options: BoundedTaskYamlOptions,
): void {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: document.contents, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const node = current.node;
    if (node === null || node === undefined) continue;
    nodes += 1;
    if (nodes > TASK_V3_MAX_JSON_NODES) {
      yamlAstError(options, node, `YAML exceeds the ${TASK_V3_MAX_JSON_NODES}-node limit.`);
    }
    if (current.depth > TASK_V3_MAX_JSON_DEPTH) {
      yamlAstError(options, node, `YAML exceeds the nesting depth of ${TASK_V3_MAX_JSON_DEPTH}.`);
    }
    if (isAlias(node)) yamlAstError(options, node, "YAML aliases are unsupported.");
    if ((node as { anchor?: unknown }).anchor !== undefined) {
      yamlAstError(options, node, "YAML anchors are unsupported.");
    }
    if ((node as { tag?: unknown }).tag) {
      yamlAstError(options, node, "custom or explicit YAML tags are unsupported.");
    }
    if (isScalar(node)) continue;
    if (isSeq(node)) {
      if (node.items.length > TASK_V3_MAX_COLLECTION_ITEMS) {
        yamlAstError(options, node, `YAML sequence exceeds the ${TASK_V3_MAX_COLLECTION_ITEMS}-item limit.`);
      }
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node.items[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (isMap(node)) {
      if (node.items.length > TASK_V3_MAX_OBJECT_KEYS) {
        yamlAstError(options, node, `YAML mapping exceeds the ${TASK_V3_MAX_OBJECT_KEYS}-key limit.`);
      }
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const pair = node.items[index];
        if (!pair) yamlAstError(options, node, "sparse YAML mappings are unsupported.");
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          yamlAstError(options, pair.key, "non-string YAML mapping keys are unsupported.");
        }
        if (!wellFormedUnicode(pair.key.value)) {
          yamlAstError(options, pair.key, "YAML mapping key must contain well-formed Unicode.");
        }
        if (utf8Bytes(pair.key.value) > TASK_V3_MAX_STRING_BYTES) {
          yamlAstError(
            options,
            pair.key,
            `YAML mapping key exceeds the ${TASK_V3_MAX_STRING_BYTES}-byte string limit.`,
          );
        }
        if (pair.key.value === "<<") yamlAstError(options, pair.key, "YAML merge keys are unsupported.");
        stack.push({ node: pair.value, depth: current.depth + 1 });
        stack.push({ node: pair.key, depth: current.depth + 1 });
      }
      continue;
    }
    yamlAstError(options, node, "unsupported YAML node kind.");
  }
}

/**
 * Parse hostile YAML without aliases/tags/merges, then hand back the bounded
 * `{root, lineAt}` pair both grammars that read a task document consume —
 * originally lifted from the now-deleted `parseTaskV3Yaml`
 * (`source-v3.ts:894-952`), generalized only by `sourceLabel`.
 *
 * P4 (docs/plans/specs/p4-deletions-closeout.md §3.2) deleted task v3
 * acceptance from `src` entirely — `parseTaskV3Yaml` and its `"task v3
 * source"` label no longer exist here (the grammar survives only in the
 * vendored, frozen `src/tasks/source/task-source-v3-frozen.ts`
 * copy, which does not call this function). The two live `src` callers
 * today: `parseTaskSourceV4`'s standalone YAML-string entry
 * (`task-source-v4.ts:790`) passes `sourceLabel: "task source v4"`; the
 * version router (`parse-task-source.ts:61`) calls this directly with
 * `sourceLabel: "task source"` — not "task v3 source" — because its front
 * end runs before `root.version` is even read, so it cannot yet know which
 * schema version the document will turn out to be.
 */
export function readBoundedTaskSourceYaml(
  input: BoundedTaskSourceYamlInput,
  options: { readonly sourceLabel: string },
): BoundedTaskSourceYamlResult {
  const sourceLabel = options.sourceLabel;
  // P4 (docs/plans/specs/p4-deletions-closeout.md §5.2, row R-R8): these six
  // throws used to omit their `code` argument and rely on the constructor's
  // `INVALID_FLAG_VALUE` default (a pre-P4 ratchet-gaming trick that kept the
  // literal string out of the grep-style count while the effective code
  // stayed generic). §5.2's target table closes that gap: every pre-version
  // failure in this bounded YAML front end (not a string, too large, YAML
  // parse/expansion) is a task-source defect, not a flag-parsing one, so each
  // now carries `TASK_SOURCE_INVALID` explicitly.
  if (typeof input.yaml !== "string") {
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}: source must be a string.`,
      "TASK_SOURCE_INVALID",
    );
  }
  const lineCounter = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(input.yaml, { lineCounter, uniqueKeys: true });
  } catch (cause) {
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}: YAML parsing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "TASK_SOURCE_INVALID",
    );
  }
  const [problem] = document.errors;
  if (problem) {
    const offset = Array.isArray(problem.pos) ? problem.pos[0] : 0;
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}:${lineCounter.linePos(offset).line}: ${yamlProblem(problem.message)}`,
      "TASK_SOURCE_INVALID",
    );
  }
  const [warning] = document.warnings;
  if (warning) {
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}: unsupported YAML construct: ${yamlProblem(warning.message)}`,
      "TASK_SOURCE_INVALID",
    );
  }
  assertBoundedTaskYamlDocument(document, { filePath: input.filePath, sourceLabel, lineCounter });
  let root: unknown;
  try {
    root = document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new UsageError(
      `Invalid ${sourceLabel} at ${input.filePath}: YAML expansion failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "TASK_SOURCE_INVALID",
    );
  }
  const lineAt = (fieldPath: readonly (string | number)[]): number | undefined => {
    for (let depth = fieldPath.length; depth >= 0; depth -= 1) {
      const node = depth === 0 ? document.contents : document.getIn(fieldPath.slice(0, depth), true);
      const range = (node as { range?: [number, number, number] | null } | null | undefined)?.range;
      if (range) return lineCounter.linePos(range[0]).line;
    }
    return undefined;
  };
  return { root, lineAt };
}
