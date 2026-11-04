import { AkmError, CONFLICT_CODES, scrubUrlCredentials } from 'akm-cli/workspace';
import { failure } from './security.js';
import { HttpFailure } from './input.js';
import { routes, type Route } from './routes.js';

/** The one place an error becomes an HTTP status and code. */
export function toHttpError(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HttpFailure) return { status: error.status, code: error.code, message };
  if (!(error instanceof AkmError)) return { status: 500, code: 'INTERNAL_ERROR', message };
  if (CONFLICT_CODES.has(error.code)) return { status: 409, code: error.code, message };
  const status = { usage: 400, 'not-found': 404, config: 409, transient: 503 }[error.kind];
  return { status, code: error.code, message };
}

export const fail = (status: number, code: string, message: string) => failure(status, code, scrubUrlCredentials(message) as string);
const failed = (error: unknown) => { const { status, code, message } = toHttpError(error); return fail(status, code, message); };

// akm results can carry SQLite integers; the envelope is plain JSON.
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? Number(item) : item);
export const success = (data: unknown) => new Response(json({ ok: true, data: scrubUrlCredentials(data) }), { headers: { 'Content-Type': 'application/json' } });
/** A response that returns literal bytes (a file's text, an explicit reveal): not scrubbed and never cached. */
const literal = (data: unknown) => new Response(json({ ok: true, data }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const DEFAULT_LIMIT = 65_536;
const DOCUMENT_LIMIT = 8 * 1_048_576;

function find(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.path.exec(path);
    if (match) return { route, params: Object.fromEntries(Object.entries(match.groups ?? {}).map(([key, value]) => [key, decodeURIComponent(value ?? '')])) };
  }
}

async function readBody(request: Request, limit: number): Promise<unknown | Response> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return failure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Actions require application/json.');
  }
  if (Number(request.headers.get('content-length')) > limit) return failure(413, 'BODY_TOO_LARGE', `Body exceeds ${limit} bytes.`);
  const reader = request.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return failure(413, 'BODY_TOO_LARGE', `Body exceeds ${limit} bytes.`); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return failure(400, 'INVALID_JSON_ARGUMENT', 'The body must be valid JSON.'); }
}

/** Serve one /api request: look the route up, apply its limits, run its operation, and wrap the result. */
export async function dispatch(request: Request, url: URL): Promise<Response> {
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (!read && request.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', 'Use GET or an explicit POST action.');
  const found = find(read ? 'GET' : 'POST', url.pathname);
  if (!found) return failure(404, 'NOT_FOUND', read ? 'No such API route.' : 'No such action.');
  const { route, params } = found;
  try {
    let input: unknown = url.searchParams;
    if (route.method === 'POST') {
      input = await readBody(request, route.limit === 'document' ? DOCUMENT_LIMIT : DEFAULT_LIMIT);
      if (input instanceof Response) return input;
    }
    const data = await route.run(input as never, params);
    return route.literal ? literal(data) : success(data);
  } catch (error) { return failed(error); }
}
