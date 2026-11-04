import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createFixture } from '../scripts/fixture.mjs';

const appRoot = process.env.AKM_DESKTOP_TEST_APP_ROOT ?? fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const electron = process.env.AKM_DESKTOP_TEST_RUNTIME ?? require('electron');

async function launch(t, { runtime = process.execPath, electronMode = false } = {}) {
  const fixture = await createFixture({ packageRoot: appRoot });
  const child = fork(path.join(appRoot, 'electron/server.mjs'), [], {
    execPath: runtime, execArgv: [],
    env: { ...fixture.env, ...(electronMode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.send('shutdown'); });
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 15000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exit ${code}: ${stderr}`)); });
    child.once('message', message => { clearTimeout(timer); resolve(message); });
  });
  const bootstrap = await fetch(ready.url, { redirect: 'manual' });
  assert.equal(bootstrap.status, 303);
  assert.equal(bootstrap.headers.get('location'), '/');
  assert.match(bootstrap.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const request = (route, body, extra = {}) => fetch(`${ready.origin}/api${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, ...(body === undefined ? {} : { Origin: ready.origin, 'Content-Type': 'application/json' }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { ...ready, fixture, cookie, request, child };
}

test('loopback session bootstrap, authentication and strict write origin', async t => {
  const app = await launch(t);
  const denied = await fetch(`${app.origin}/api/meta`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, 'UNAUTHORIZED');
  assert.equal((await fetch(`${app.origin}/api/meta`, { headers: { Cookie: 'akm_desktop_session=invalid' } })).status, 401);
  assert.equal((await app.request('/knowledge/create', { name: 'bad', content: '# bad' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await app.request('/knowledge/create', { name: 'bad', content: '# bad' }, { Origin: '' })).status, 403);
  assert.equal((await app.request('/knowledge/create', { name: 'bad', content: '# bad' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.request('/unknown')).status, 404);
  assert.equal((await fetch(`${app.origin}/api/desktop/software`)).status, 401);
  assert.equal((await app.request('/desktop/software', { action: 'install-cli' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await app.request('/desktop/software', { action: 'desktop-menu-install' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await app.request('/desktop/software', { action: 'shell', command: 'anything' })).status, 400);
  assert.equal((await app.request('/desktop/software', { action: 'install-plugin', harness: 'unexpected' })).status, 400);
  const software = (await (await app.request('/desktop/software')).json()).data;
  assert.equal(software.host.phase, 'idle', 'Reading status must not invoke installers or model-backed operations');
  assert.equal(software.desktop.supported, false, 'A server without Electron must not claim it can update the app');
  const badHost = await new Promise((resolve, reject) => {
    const req = http.get(`${app.origin}/api/meta`, { headers: { Host: 'evil.example', Cookie: app.cookie } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await app.request('/meta', undefined, { 'x-akm-desktop-protocol': 'https' })).status, 200);
  const rawAction = body => fetch(`${app.origin}/api/feedback`, {
    method: 'POST', headers: { Cookie: app.cookie, Origin: app.origin, 'Content-Type': 'application/json' }, body
  });
  assert.equal((await rawAction('{')).status, 400);
  assert.equal((await rawAction(' '.repeat(65_537))).status, 413);
  const page = await fetch(app.origin, { headers: { Cookie: app.cookie } });
  assert.equal(page.status, 200, 'Serve the completed production build before checking its CSP');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src[^;]*'nonce-/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /unsafe-inline/);
  const desktop = await (await app.request('/desktop')).json();
  assert.equal(desktop.ok, true);
  assert.equal(typeof desktop.data.hostname, 'string');
  assert.equal(typeof desktop.data.akmVersion, 'string');
  assert.equal((await (await app.request('/desktop/preferences')).json()).data.theme, 'system');
  assert.equal((await app.request('/desktop/preferences', { theme: 'dark', unrelated: true })).status, 400);
  assert.equal((await app.request('/desktop/preferences', { theme: 'invalid' })).status, 400);
  assert.equal((await app.request('/desktop/preferences', { theme: 'dark' })).status, 200);
  assert.equal((await (await app.request('/desktop/preferences')).json()).data.theme, 'dark');
  assert.equal(JSON.parse(await readFile(path.join(app.fixture.env.XDG_CONFIG_HOME, 'akm-desktop/preferences.json'), 'utf8')).theme, 'dark');
  const configResponse = await app.request('/config');
  const configText = await configResponse.text();
  const token = new URL(app.url).searchParams.get('desktop_session');
  assert.ok(!configText.includes(token), 'The session credential must never be returned by AKM config inspection');
  const config = JSON.parse(configText).data;
  assert.equal(config.env.find(item => item.name === 'AKM_DESKTOP_SESSION_TOKEN'), undefined, 'the credential is removed from the server environment');
  assert.ok(!config.env.some(item => item.name === 'AKM_DESKTOP_SESSION'));
});

test('existing AKM reads, revision-safe editing, creation and non-overwriting copy', async t => {
  const app = await launch(t);
  const sourceRoute = `/asset/source?ref=${encodeURIComponent(app.fixture.refs.document)}`;
  const source = (await (await app.request(sourceRoute)).json()).data;
  assert.equal(source.content, app.fixture.content);
  const saved = await app.request('/asset/save', { ref: source.ref, revision: source.revision, content: source.content + '\nA verified extra step.\n' });
  assert.equal(saved.status, 200, await saved.text());
  const conflict = await app.request('/asset/save', { ref: source.ref, revision: source.revision, content: '# obsolete' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'ASSET_CONTENT_CHANGED');
  const created = await app.request('/knowledge/create', { name: 'created-in-test', content: '# Created\n\nA synthetic new note.', bundle: 'personal' });
  assert.equal(created.status, 200, await created.text());
  const copied = await app.request('/asset/copy', { sourceRef: app.fixture.refs.vendor, target: 'personal', newName: 'vendor-copy' });
  assert.equal(copied.status, 200, await copied.text());
  const repeat = await app.request('/asset/copy', { sourceRef: app.fixture.refs.vendor, target: 'personal', newName: 'vendor-copy' });
  assert.notEqual(repeat.status, 200);
  assert.equal((await app.request('/asset/copy', { sourceRef: app.fixture.refs.vendor, force: true })).status, 400);
  const vendor = await app.request(`/asset/source?ref=${encodeURIComponent(app.fixture.refs.vendor)}`);
  assert.notEqual(vendor.status, 200);
  const history = await app.request(`/asset/history?ref=${encodeURIComponent(app.fixture.refs.document)}`);
  assert.equal(history.status, 200);
  assert.match(await readFile(app.fixture.documentPath, 'utf8'), /verified extra step/);
  const memory = (await (await app.request(`/asset/source?ref=${encodeURIComponent(app.fixture.refs.memory)}`)).json()).data;
  assert.equal(memory.type, 'memory');
  const memorySaved = await app.request('/asset/save', { ref: memory.ref, revision: memory.revision, content: memory.content + '\nVerify the copy regularly.\n' });
  assert.equal(memorySaved.status, 200, await memorySaved.text());
});

test('Electron Node child loads native SQLite and existing CLI-spawning workspace actions', async t => {
  const app = await launch(t, { runtime: electron, electronMode: true });
  const search = await app.request('/search?q=backup');
  assert.equal(search.status, 200, await search.text());
  // feedback executes AKM's existing argument-validated CLI subprocess.
  const action = await app.request('/feedback', { ref: app.fixture.refs.document, signal: 'positive' });
  assert.equal(action.status, 200, await action.text());
  const proposals = await app.request('/proposals');
  assert.equal(proposals.status, 200, await proposals.text());
  const missing = await app.request('/proposals/nonexistent/accept', {});
  assert.equal(missing.status, 404);
});
