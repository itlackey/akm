import { UsageError } from "akm-cli/workspace";

/** A failure Desktop itself raises, with the status and stable code its renderer reads. */
export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const warned = new Set<string>();
/**
 * The fields of a request body an operation knows. Shape is checked here (it must be an object); what a field means is the
 * operation's to decide. An unknown field is ignored with one warning, never rejected.
 */
export function fields<T = Record<string, unknown>>(body: unknown, keys: readonly string[], where: string): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new UsageError("A JSON object is required.");
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (keys.includes(key)) result[key] = value;
    else if (!warned.has(where + " " + key)) {
      warned.add(where + " " + key);
      console.warn(`[desktop] ${where}: ignoring unknown field "${key}".`);
    }
  }
  return result as T;
}

/** A positive integer query parameter; anything else is ignored and the operation's default applies. */
export function count(query: URLSearchParams, name: string): number | undefined {
  const value = Number(query.get(name));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export const text = (query: URLSearchParams, name: string): string => query.get(name) ?? "";
export const flag = (query: URLSearchParams, name: string): boolean => ["1", "true"].includes(query.get(name) ?? "");
