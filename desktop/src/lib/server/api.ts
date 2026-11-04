import os from 'node:os';
import { createRequire } from 'node:module';
import {
  AkmError, akmClone, classifyProposalError, classifyWorkspaceError,
  handleApiRequest, handleWorkspaceAction, handleWriteRequest,
  matchWorkspaceAction, matchWriteRoute, NO_SUCH_ROUTE, scrubUrlCredentials
} from 'akm-cli/workspace';
import { failure } from './security.js';
import { readPreferences, saveTheme, validTheme } from './preferences.js';
import { desktopUpdate, hostTools } from './software.mjs';
import { isSensitiveRef, sensitiveMetadata, revealSensitive, mutateSensitive } from './sensitive-assets.js';

const fail = (status: number, code: string, message: string) =>
  failure(status, code, scrubUrlCredentials(message) as string);
const success = (data: unknown) => new Response(JSON.stringify({ ok: true, data: scrubUrlCredentials(data) },
  (_key, value: unknown) => typeof value === 'bigint' ? Number(value) : value),
  { headers: { 'Content-Type': 'application/json' } });

const require = createRequire(import.meta.url);
const akmPackage = require('akm-cli/package.json') as { version: string };

export async function dispatch(request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (request.method === 'GET' || request.method === 'HEAD') {
    try {
      const data = path === '/api/desktop'
        ? { hostname: os.hostname(), version: process.env.AKM_DESKTOP_VERSION ?? 'development', akmVersion: akmPackage.version, commit: process.env.AKM_DESKTOP_COMMIT }
        : path === '/api/desktop/preferences' ? await readPreferences()
        : path === '/api/desktop/software' ? { host: hostTools.snapshot(), desktop: await desktopUpdate() }
        : path === '/api/asset/sensitive' || (path === '/api/asset' && isSensitiveRef(url.searchParams.get('ref') ?? ''))
          ? sensitiveMetadata(Object.fromEntries(url.searchParams))
        : await handleApiRequest(path, url.searchParams);
      if (data === NO_SUCH_ROUTE) return failure(404, 'NOT_FOUND', 'No such API route.');
      return success(data);
    } catch (error) {
      if (path === '/api/asset/source') {
        const result = classifyWorkspaceError(error);
        return fail(result.status, result.code, result.message);
      }
      if (error instanceof AkmError) {
        const status = error.kind === 'not-found' ? 404 : error.kind === 'usage' ? 400 : error.kind === 'transient' ? 503 : 500;
        return fail(status, error.code, error.message);
      }
      return failure(500, 'INTERNAL_ERROR', 'AKM could not complete this request.');
    }
  }
  if (request.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', 'Use GET or an explicit POST action.');
  const workspace = matchWorkspaceAction(path);
  const proposal = matchWriteRoute(path);
  const copy = path === '/api/asset/copy';
  const preferences = path === '/api/desktop/preferences';
  const software = path === '/api/desktop/software';
  const reveal = path === '/api/asset/reveal';
  const sensitiveActions: Record<string, 'create' | 'save' | 'delete'> = { '/api/asset/sensitive/create': 'create', '/api/asset/sensitive/save': 'save', '/api/asset/sensitive/delete': 'delete' };
  const sensitiveAction = sensitiveActions[path];
  if (!workspace && !proposal && !copy && !preferences && !software && !reveal && !sensitiveAction) return failure(404, 'NOT_FOUND', 'No such action.');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return failure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Actions require application/json.');
  }
  const limit = workspace === 'document-save' || workspace === 'knowledge-create' || sensitiveAction ? 8 * 1_048_576 : 65_536;
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
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return failure(400, 'INVALID_JSON_ARGUMENT', 'The body must be valid JSON.'); }
  try {
    let data: unknown;
    // The explicit, authenticated reveal is the sole response that returns
    // literal secret bytes. Do not run the generic URL-credential scrubber.
    if (reveal) return Response.json({ ok: true, data: revealSensitive(body) }, { headers: { 'Cache-Control': 'no-store' } });
    if (sensitiveAction) return success(mutateSensitive(sensitiveAction, body));
    if (software) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(400, 'INVALID_SOFTWARE_ACTION', 'A software action is required.');
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some(key => !['action', 'harness', 'channel', 'settings'].includes(key)) || typeof value.action !== 'string')
        return failure(400, 'INVALID_SOFTWARE_ACTION', 'Invalid software action.');
      if ((value.harness !== undefined && typeof value.harness !== 'string') || (value.channel !== undefined && typeof value.channel !== 'string'))
        return failure(400, 'INVALID_SOFTWARE_ACTION', 'Invalid harness or release channel.');
      try {
        if (value.action === 'desktop-check') data = await desktopUpdate('check');
        else if (value.action === 'desktop-settings') data = await desktopUpdate('settings', value.settings);
        else if (value.action === 'desktop-menu-install') {
          if (Object.keys(value).length !== 1) throw new Error('Menu installation does not accept custom paths or settings.');
          data = await desktopUpdate('menu-install');
        }
        else data = hostTools.start(value.action, value.harness, value.channel);
      } catch (error) {
        return fail(400, 'SOFTWARE_ACTION_FAILED', error instanceof Error ? error.message : 'Software operation failed.');
      }
    } else if (preferences) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('theme' in body) || !validTheme(body.theme)) {
        return failure(400, 'INVALID_PREFERENCE', 'Choose system, light, or dark appearance.');
      }
      data = await saveTheme(body.theme);
    } else if (copy) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(400, 'INVALID_JSON_ARGUMENT', 'A JSON object is required.');
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some(key => !['sourceRef', 'target', 'newName'].includes(key)) ||
        typeof value.sourceRef !== 'string' || !value.sourceRef.trim() || value.sourceRef.startsWith('-') ||
        (value.target !== undefined && (typeof value.target !== 'string' || !value.target.trim() || value.target.startsWith('-'))) ||
        (value.newName !== undefined && (typeof value.newName !== 'string' || !value.newName.trim()))) {
        return failure(400, 'INVALID_JSON_ARGUMENT', 'Provide sourceRef and optional target bundle and newName; overwriting is not supported.');
      }
      data = await akmClone({ sourceRef: value.sourceRef, target: value.target as string | undefined, newName: value.newName as string | undefined, force: false });
    } else if (workspace) data = await handleWorkspaceAction(workspace, body);
    else data = await handleWriteRequest(proposal!, body);
    return success(data);
  } catch (error) {
    const result = proposal ? classifyProposalError(error) : classifyWorkspaceError(error);
    return fail(result.status, result.code, result.message);
  }
}
