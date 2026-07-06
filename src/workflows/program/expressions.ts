// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The deterministic expression language for YAML orchestration programs
 * (R1 redesign addendum). `${{ ... }}` delimits references; everything else
 * is literal text that passes through byte-exact.
 *
 * The grammar is CLOSED — exactly four roots, nothing else parses:
 *
 *   params.<ident>
 *   steps.<ident>.output( .<ident> | [<non-negative int>] )*
 *   item
 *   item_index
 *
 * where <ident> is `[A-Za-z_][A-Za-z0-9_-]*`. No functions, no clock, no
 * randomness, no ambient lookup — orchestration decisions stay pure
 * functions of (frozen plan, params, journaled unit results).
 *
 * Templates are parsed ONCE into literal/reference segments; resolution is a
 * single pass over that AST. Substituted content is data, never re-scanned,
 * so a value containing `${{ params.x }}` is inserted literally — the P1
 * re-scan injection bug class is structurally impossible.
 *
 * There is deliberately NO escape syntax in v1: a literal `${{` cannot
 * appear in instructions. Authors who write one get a parse error from the
 * validator (unterminated or invalid reference) telling them so.
 *
 * Pure module: no IO, no engine imports.
 */

const OPEN = "${{";
const CLOSE = "}}";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExpressionAst =
  | { kind: "param"; name: string }
  | { kind: "stepOutput"; stepId: string; path: Array<string | number> }
  | { kind: "item" }
  | { kind: "itemIndex" };

export type TemplateSegment =
  | { kind: "literal"; text: string }
  /** `raw` is the full `${{ ... }}` source text; `index` its offset in the template. */
  | { kind: "reference"; expr: ExpressionAst; raw: string; index: number };

export interface TemplateParseError {
  /** Character offset in the template where the problem starts (the offending opener). */
  index: number;
  message: string;
}

export type ParseTemplateResult =
  | { ok: true; segments: TemplateSegment[] }
  | { ok: false; errors: TemplateParseError[] };

export interface ExpressionScope {
  params: Record<string, unknown>;
  /** Step artifacts keyed by step id; each value is that step's `output`. */
  stepOutputs: Record<string, unknown>;
  item?: unknown;
  itemIndex?: number;
}

export interface ResolutionError {
  /** Canonical spelling of the reference that failed, e.g. `steps.review.output.files[2]`. */
  reference: string;
  message: string;
}

export type ResolveTemplateResult = { ok: true; text: string } | { ok: false; errors: ResolutionError[] };

export type ResolveReferenceResult = { ok: true; value: unknown } | { ok: false; error: ResolutionError };

// ── Template parsing ─────────────────────────────────────────────────────────

/**
 * Split a template into literal and reference segments. Literal text passes
 * through byte-exact, including `$`, `{`, `}`, `${`, `{{`, and `}}` sequences
 * that do not form the exact `${{` opener. Errors are returned, not thrown.
 */
export function parseTemplate(template: string): ParseTemplateResult {
  const segments: TemplateSegment[] = [];
  const errors: TemplateParseError[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const open = template.indexOf(OPEN, cursor);
    if (open === -1) break;
    if (open > cursor) segments.push({ kind: "literal", text: template.slice(cursor, open) });

    const close = template.indexOf(CLOSE, open + OPEN.length);
    const nested = template.indexOf(OPEN, open + OPEN.length);
    if (close === -1) {
      errors.push({
        index: open,
        message:
          `Unterminated ${OPEN} reference (no matching ${CLOSE}). ` +
          `Note: there is no escape syntax — a literal ${OPEN} cannot appear in this text.`,
      });
      cursor = template.length;
      break;
    }
    if (nested !== -1 && nested < close) {
      errors.push({
        index: nested,
        message: `Nested ${OPEN} inside a reference — references cannot contain other references.`,
      });
      cursor = close + CLOSE.length;
      continue;
    }

    const inner = template.slice(open + OPEN.length, close);
    const parsed = parseExpression(inner);
    if (parsed.ok) {
      segments.push({
        kind: "reference",
        expr: parsed.expr,
        raw: template.slice(open, close + CLOSE.length),
        index: open,
      });
    } else {
      errors.push({ index: open, message: parsed.message });
    }
    cursor = close + CLOSE.length;
  }

  if (cursor < template.length) segments.push({ kind: "literal", text: template.slice(cursor) });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, segments };
}

const GRAMMAR_HINT = "allowed forms: params.<name>, steps.<id>.output[...], item, item_index";

/**
 * Parse a single expression (the text between `${{` and `}}`, or a bare
 * whole-value field such as `map.over` after delimiter stripping).
 */
export function parseExpression(source: string): { ok: true; expr: ExpressionAst } | { ok: false; message: string } {
  const text = source.trim();
  if (text === "") return { ok: false, message: `Empty expression inside ${OPEN} ${CLOSE}; ${GRAMMAR_HINT}.` };

  const root = readIdent(text, 0);
  if (!root) {
    return { ok: false, message: `Invalid expression "${text}" — must start with an identifier; ${GRAMMAR_HINT}.` };
  }

  switch (root.name) {
    case "item":
    case "item_index": {
      if (root.end !== text.length) {
        return { ok: false, message: `"${root.name}" takes no path — found trailing "${text.slice(root.end)}".` };
      }
      return { ok: true, expr: root.name === "item" ? { kind: "item" } : { kind: "itemIndex" } };
    }
    case "params": {
      if (text[root.end] !== ".") {
        return { ok: false, message: `"params" requires a name: params.<name> (got "${text}").` };
      }
      const name = readIdent(text, root.end + 1);
      if (!name) {
        return { ok: false, message: `Invalid param name after "params." in "${text}".` };
      }
      if (name.end !== text.length) {
        return {
          ok: false,
          message: `"params.${name.name}" takes exactly one name — found trailing "${text.slice(name.end)}".`,
        };
      }
      return { ok: true, expr: { kind: "param", name: name.name } };
    }
    case "steps": {
      if (text[root.end] !== ".") {
        return { ok: false, message: `"steps" requires a step id: steps.<id>.output (got "${text}").` };
      }
      const stepId = readIdent(text, root.end + 1);
      if (!stepId) {
        return { ok: false, message: `Invalid step id after "steps." in "${text}".` };
      }
      if (text[stepId.end] !== ".") {
        return { ok: false, message: `"steps.${stepId.name}" must be followed by ".output" (got "${text}").` };
      }
      const output = readIdent(text, stepId.end + 1);
      if (!output || output.name !== "output") {
        return { ok: false, message: `Expected ".output" after "steps.${stepId.name}" in "${text}".` };
      }
      const path = parsePath(text, output.end);
      if (!path.ok) return { ok: false, message: path.message };
      return { ok: true, expr: { kind: "stepOutput", stepId: stepId.name, path: path.path } };
    }
    default:
      return { ok: false, message: `Unknown root "${root.name}" in "${text}"; ${GRAMMAR_HINT}.` };
  }
}

/** `<ident>` is `[A-Za-z_][A-Za-z0-9_-]*`. Returns null when no ident starts at `start`. */
function readIdent(text: string, start: number): { name: string; end: number } | null {
  if (start >= text.length || !/[A-Za-z_]/.test(text[start])) return null;
  let end = start + 1;
  while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end++;
  return { name: text.slice(start, end), end };
}

/** Parse `( .<ident> | [<non-negative int>] )*` from `start` to end of text. */
function parsePath(
  text: string,
  start: number,
): { ok: true; path: Array<string | number> } | { ok: false; message: string } {
  const path: Array<string | number> = [];
  let i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === ".") {
      const ident = readIdent(text, i + 1);
      if (!ident) {
        return { ok: false, message: `Invalid path segment after "." at position ${i} in "${text}".` };
      }
      path.push(ident.name);
      i = ident.end;
    } else if (char === "[") {
      let j = i + 1;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
      if (j === i + 1 || text[j] !== "]") {
        return {
          ok: false,
          message: `Invalid indexer at position ${i} in "${text}" — expected [<non-negative integer>].`,
        };
      }
      path.push(Number.parseInt(text.slice(i + 1, j), 10));
      i = j + 1;
    } else {
      return { ok: false, message: `Unexpected character "${char}" at position ${i} in "${text}".` };
    }
  }
  return { ok: true, path };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve parsed segments against a scope in a SINGLE pass — resolved values
 * are concatenated as data and never re-scanned for further references.
 * Strings insert verbatim; numbers/booleans via String(); objects/arrays as
 * canonical JSON (recursively sorted keys); null/undefined/missing paths are
 * resolution errors naming the reference.
 */
export function resolveTemplate(segments: TemplateSegment[], scope: ExpressionScope): ResolveTemplateResult {
  const parts: string[] = [];
  const errors: ResolutionError[] = [];
  for (const segment of segments) {
    if (segment.kind === "literal") {
      parts.push(segment.text);
      continue;
    }
    const resolved = resolveReference(segment.expr, scope);
    if (!resolved.ok) {
      errors.push(resolved.error);
      continue;
    }
    const value = resolved.value;
    if (typeof value === "string") {
      parts.push(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
    } else if (typeof value === "object" && value !== null) {
      parts.push(canonicalJson(value));
    } else {
      errors.push({
        reference: formatReference(segment.expr),
        message: `${formatReference(segment.expr)} resolved to an unsupported value type (${typeof value}).`,
      });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, text: parts.join("") };
}

/**
 * Resolve a single reference to its RAW value for whole-value contexts
 * (`map.over`, `route.input`): arrays stay arrays, objects stay objects.
 * null/undefined values and missing paths are errors, same as in templates.
 */
export function resolveReference(expr: ExpressionAst, scope: ExpressionScope): ResolveReferenceResult {
  const reference = formatReference(expr);
  const fail = (message: string): ResolveReferenceResult => ({ ok: false, error: { reference, message } });

  switch (expr.kind) {
    case "param": {
      if (!Object.hasOwn(scope.params, expr.name)) {
        return fail(`${reference} is not defined in the run's params.`);
      }
      return finish(scope.params[expr.name], reference, fail);
    }
    case "item": {
      if (scope.item === undefined) return fail("item is only available inside a map unit.");
      return finish(scope.item, reference, fail);
    }
    case "itemIndex": {
      if (typeof scope.itemIndex !== "number") return fail("item_index is only available inside a map unit.");
      return { ok: true, value: scope.itemIndex };
    }
    case "stepOutput": {
      if (!Object.hasOwn(scope.stepOutputs, expr.stepId)) {
        return fail(`steps.${expr.stepId}.output is not available — step "${expr.stepId}" has no recorded output.`);
      }
      let current: unknown = scope.stepOutputs[expr.stepId];
      let walked = `steps.${expr.stepId}.output`;
      for (const segment of expr.path) {
        if (typeof segment === "number") {
          if (!Array.isArray(current)) {
            return fail(`${walked} is not an array — cannot resolve index [${segment}].`);
          }
          if (segment >= current.length) {
            return fail(`${walked}[${segment}] is out of bounds (array length ${current.length}).`);
          }
          current = current[segment];
          walked += `[${segment}]`;
        } else {
          if (typeof current !== "object" || current === null || Array.isArray(current)) {
            return fail(`${walked} is not an object — cannot resolve property "${segment}".`);
          }
          if (!Object.hasOwn(current, segment)) {
            return fail(`${walked}.${segment} is missing (no such property, resolving ${reference}).`);
          }
          current = (current as Record<string, unknown>)[segment];
          walked += `.${segment}`;
        }
      }
      return finish(current, reference, fail);
    }
  }
}

function finish(
  value: unknown,
  reference: string,
  fail: (message: string) => ResolveReferenceResult,
): ResolveReferenceResult {
  if (value === undefined) return fail(`${reference} resolved to undefined.`);
  if (value === null) return fail(`${reference} resolved to null.`);
  return { ok: true, value };
}

// ── Introspection helpers ────────────────────────────────────────────────────

/** The reference ASTs of a parsed template, in document order — for validator edge checking. */
export function listReferences(segments: TemplateSegment[]): ExpressionAst[] {
  const references: ExpressionAst[] = [];
  for (const segment of segments) {
    if (segment.kind === "reference") references.push(segment.expr);
  }
  return references;
}

/** Canonical source spelling of a reference, e.g. `steps.review.output.files[2].name`. */
export function formatReference(expr: ExpressionAst): string {
  switch (expr.kind) {
    case "param":
      return `params.${expr.name}`;
    case "item":
      return "item";
    case "itemIndex":
      return "item_index";
    case "stepOutput": {
      let text = `steps.${expr.stepId}.output`;
      for (const segment of expr.path) {
        text += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
      }
      return text;
    }
  }
}

// ── Canonical JSON ───────────────────────────────────────────────────────────

/**
 * Stable stringify with recursively sorted object keys, so equal values
 * render identically regardless of key insertion order. Same pattern as the
 * module-private helper in exec/native-executor.ts (not exported there).
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
