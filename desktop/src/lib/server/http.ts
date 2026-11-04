import { classifyWorkspaceError, scrubUrlCredentials, UsageError } from 'akm-cli/workspace';
import { failure } from './security.js';

/**
 * The one place an error becomes an HTTP status. akm's classifier owns what a stale proposal, a held lease or a
 * read-only bundle means; a plain Error is an internal failure, and its text is passed on (scrubbed by `fail`).
 */
export function toHttpError(error: unknown) { return classifyWorkspaceError(error); }

export const fail = (status: number, code: string, message: string) =>
  failure(status, code, scrubUrlCredentials(message) as string);
export const failed = (error: unknown) => { const { status, code, message } = toHttpError(error); return fail(status, code, message); };

export const success = (data: unknown) => new Response(JSON.stringify({ ok: true, data: scrubUrlCredentials(data) },
  (_key, value: unknown) => typeof value === 'bigint' ? Number(value) : value),
  { headers: { 'Content-Type': 'application/json' } });

const warned = new Set<string>();
/** The fields of a request body Desktop knows. An unknown field is ignored with one warning, never an error. */
export function known(body: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UsageError('A JSON object is required.');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (keys.includes(key)) result[key] = value;
    else if (!warned.has(where + ' ' + key)) { warned.add(where + ' ' + key); console.warn(`[desktop] ${where}: ignoring unknown field "${key}".`); }
  }
  return result;
}
