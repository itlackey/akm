import os from 'node:os';
import { createRequire } from 'node:module';
import {
  akmClone, handleApiRequest, handleWorkspaceAction, handleWriteRequest,
  matchWorkspaceAction, matchWriteRoute, NO_SUCH_ROUTE
} from 'akm-cli/workspace';
import { failure } from './security.js';
import { fail, failed, known, success } from './http.js';
import { readPreferences, saveTheme, validTheme } from './preferences.js';
import { desktopApp, hostTools } from './software.mjs';
import { sensitiveMetadata, revealSensitive, mutateSensitive } from './sensitive-assets.js';
import { readFile, saveFile } from './features/files.js';

const require = createRequire(import.meta.url);
const akmPackage = require('akm-cli/package.json') as { version: string };

// Everything Desktop itself owns is under /api/desktop/*. Every other path is akm's.
const sensitiveActions: Record<string, 'create' | 'save' | 'delete'> = {
  '/api/desktop/sensitive/create': 'create', '/api/desktop/sensitive/save': 'save', '/api/desktop/sensitive/delete': 'delete'
};
const ownPosts = ['/api/desktop/preferences', '/api/desktop/software', '/api/desktop/sensitive/reveal', '/api/desktop/file/save', '/api/asset/copy'];

export async function dispatch(request: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (request.method === 'GET' || request.method === 'HEAD') {
    try {
      // File text and the explicit reveal are the only responses that return literal bytes: no URL-credential scrubbing.
      if (path === '/api/desktop/file') return Response.json({ ok: true, data: await readFile(Object.fromEntries(url.searchParams)) }, { headers: { 'Cache-Control': 'no-store' } });
      const data = path === '/api/desktop'
        ? { hostname: os.hostname(), version: process.env.AKM_DESKTOP_VERSION ?? 'development', akmVersion: akmPackage.version, commit: process.env.AKM_DESKTOP_COMMIT }
        : path === '/api/desktop/preferences' ? await readPreferences()
        : path === '/api/desktop/software' ? { host: hostTools.snapshot(), desktop: await desktopApp() }
        : path === '/api/desktop/sensitive' ? sensitiveMetadata(Object.fromEntries(url.searchParams))
        : await handleApiRequest(path, url.searchParams);
      if (data === NO_SUCH_ROUTE) return failure(404, 'NOT_FOUND', 'No such API route.');
      return success(data);
    } catch (error) { return failed(error); }
  }
  if (request.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', 'Use GET or an explicit POST action.');
  const workspace = matchWorkspaceAction(path);
  const proposal = matchWriteRoute(path);
  const sensitiveAction = sensitiveActions[path];
  if (!workspace && !proposal && !sensitiveAction && !ownPosts.includes(path)) return failure(404, 'NOT_FOUND', 'No such action.');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return failure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Actions require application/json.');
  }
  const limit = workspace === 'document-save' || workspace === 'knowledge-create' || sensitiveAction || path === '/api/desktop/file/save' ? 8 * 1_048_576 : 65_536;
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
    // The explicit, authenticated reveal is the sole response that returns
    // literal secret bytes. Do not run the generic URL-credential scrubber.
    if (path === '/api/desktop/sensitive/reveal') return Response.json({ ok: true, data: revealSensitive(body) }, { headers: { 'Cache-Control': 'no-store' } });
    if (sensitiveAction) return success(mutateSensitive(sensitiveAction, body));
    if (path === '/api/desktop/file/save') return success(await saveFile(body));
    let data: unknown;
    if (path === '/api/desktop/software') {
      const value = known(body, ['action', 'harness', 'channel'], 'software action');
      if (typeof value.action !== 'string' || (value.harness !== undefined && typeof value.harness !== 'string') ||
        (value.channel !== undefined && typeof value.channel !== 'string')) return failure(400, 'INVALID_SOFTWARE_ACTION', 'Invalid software action, harness or release channel.');
      try {
        data = value.action === 'desktop-menu-install' ? await desktopApp('menu-install') : hostTools.start(value.action, value.harness, value.channel);
      } catch (error) {
        return fail(400, 'SOFTWARE_ACTION_FAILED', error instanceof Error ? error.message : 'Software operation failed.');
      }
    } else if (path === '/api/desktop/preferences') {
      const { theme } = known(body, ['theme'], 'preferences');
      if (!validTheme(theme)) return failure(400, 'INVALID_PREFERENCE', 'Choose system, light, or dark appearance.');
      data = await saveTheme(theme);
    } else if (path === '/api/asset/copy') {
      const value = known(body, ['sourceRef', 'target', 'newName'], 'copy');
      if (typeof value.sourceRef !== 'string' || !value.sourceRef.trim() || value.sourceRef.startsWith('-') ||
        (value.target !== undefined && (typeof value.target !== 'string' || !value.target.trim() || value.target.startsWith('-'))) ||
        (value.newName !== undefined && (typeof value.newName !== 'string' || !value.newName.trim())))
        return failure(400, 'INVALID_JSON_ARGUMENT', 'Provide sourceRef and optional target bundle and newName; overwriting is not supported.');
      data = await akmClone({ sourceRef: value.sourceRef, target: value.target as string | undefined, newName: value.newName as string | undefined, force: false });
    } else if (workspace) data = await handleWorkspaceAction(workspace, body);
    else data = await handleWriteRequest(proposal!, body);
    return success(data);
  } catch (error) { return failed(error); }
}
