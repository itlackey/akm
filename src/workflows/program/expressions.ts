// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The workflow reference-string grammar — exactly two roots:
 *
 *   params.<ident>
 *   steps.<ident>.output( .<ident> | [<non-negative int>] )*
 *
 * where <ident> is `[A-Za-z_][A-Za-z0-9_-]*`. Whole-value only, in `map.over`,
 * `route.input`, `inputs[]`, `outputs.<n>.from`, and a binding's `from`; prose
 * is never scanned. No functions, no ambient lookup. Pure.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ExpressionAst =
  | { kind: "param"; name: string }
  | { kind: "stepOutput"; stepId: string; path: Array<string | number> };

export interface ExpressionScope {
  params: Record<string, unknown>;
  /** Step artifacts keyed by step id; each value is that step's `output`. */
  stepOutputs: Record<string, unknown>;
}

export interface ResolutionError {
  /** Canonical spelling of the reference that failed, e.g. `steps.review.output.files[2]`. */
  reference: string;
  message: string;
}

export type ResolveReferenceResult = { ok: true; value: unknown } | { ok: false; error: ResolutionError };

const GRAMMAR_HINT = "allowed forms: params.<name>, steps.<id>.output(.<ident>|[<int>])*";

/**
 * Parse a bare reference string (a whole-value frontmatter field, already
 * delimiter-free: `map.over`, `route.input`, or one entry of `inputs[]`).
 */
export function parseReference(source: string): { ok: true; expr: ExpressionAst } | { ok: false; message: string } {
  const text = source.trim();
  if (text === "") return { ok: false, message: `Empty reference; ${GRAMMAR_HINT}.` };

  const root = readIdent(text, 0);
  if (!root) {
    return { ok: false, message: `Invalid reference "${text}" — must start with an identifier; ${GRAMMAR_HINT}.` };
  }

  switch (root.name) {
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
  if (start >= text.length || !/[A-Za-z_]/.test(text[start]!)) return null;
  let end = start + 1;
  while (end < text.length && /[A-Za-z0-9_-]/.test(text[end]!)) end++;
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
      while (j < text.length && /[0-9]/.test(text[j]!)) j++;
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
 * Resolve a single reference to its RAW value for whole-value contexts
 * (`map.over`, `route.input`, `inputs[]`): arrays stay arrays, objects stay
 * objects. null/undefined values and missing paths are errors.
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

/**
 * Resolve a bare reference STRING directly (parse + resolve in one call) —
 * the shape every whole-value frontmatter position (`map.over`, `route.input`,
 * one entry of `inputs[]`) actually needs.
 */
export function resolveReferenceString(text: string, scope: ExpressionScope): ResolveReferenceResult {
  const parsed = parseReference(text);
  if (!parsed.ok) {
    return { ok: false, error: { reference: text, message: parsed.message } };
  }
  return resolveReference(parsed.expr, scope);
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

/** Canonical source spelling of a reference, e.g. `steps.review.output.files[2].name`. */
export function formatReference(expr: ExpressionAst): string {
  switch (expr.kind) {
    case "param":
      return `params.${expr.name}`;
    case "stepOutput": {
      let text = `steps.${expr.stepId}.output`;
      for (const segment of expr.path) {
        text += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
      }
      return text;
    }
  }
}
