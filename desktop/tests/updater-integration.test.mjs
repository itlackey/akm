import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { createFixture } from '../scripts/fixture.mjs';

const require = createRequire(import.meta.url);
const image = process.env.AKM_DESKTOP_TEST_RUNTIME;
for (const stable of [false, true]) test(`real electron-updater installs a disposable ${stable ? 'stable menu' : 'versioned download'} AppImage on quit`, { skip: !image, timeout: 120000 }, async t => {
  const fixture = await createFixture({ index: false });
  const root = await mkdtemp(path.join(os.tmpdir(), 'akm-update-integration-'));
  const feed = load(await readFile(path.join(path.dirname(image), 'latest-linux.yml'), 'utf8'));
  const expected = createHash('sha512').update(await readFile(image)).digest('base64');
  assert.equal(feed.files[0].sha512, expected);
  const installDir = path.join(root, 'install'); await mkdir(installDir);
  const old = path.join(installDir, stable ? 'akm-desktop.AppImage' : 'AKM-Desktop-0.0.2-x86_64.AppImage');
  await cp(image, old); // Only this generated copy may be replaced by the updater.
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization === 'token synthetic' });
    if (req.headers.authorization !== 'token synthetic') return res.writeHead(401).end();
    if (req.url.startsWith('/latest-linux.yml')) { res.writeHead(200); res.end(JSON.stringify(feed)); }
    else if (req.url === '/' + feed.files[0].url) {
      res.writeHead(200, { 'Content-Length': feed.files[0].size });
      createReadStream(image).pipe(res);
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  // A real Electron main process under a synthetic 0.0.2 package; no live app,
  // credentials, update preferences or installed image is touched.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'akm-updater-fixture', version: '0.0.2', type: 'module', main: 'main.mjs' }));
  await writeFile(path.join(root, 'update.yml'), 'provider: generic\nurl: ' + url + '\nupdaterCacheDirName: synthetic-updater\n');
  await writeFile(path.join(root, 'main.mjs'), `
import {app} from 'electron';
import updater from ${JSON.stringify(pathToFileURL(require.resolve('electron-updater')).href)};
void app.whenReady().then(async()=>{
const u=new updater.AppImageUpdater({provider:'generic',url:${JSON.stringify(url)},useMultipleRangeRequest:false});
u.forceDevUpdateConfig=true;
u.updateConfigPath=${JSON.stringify(path.join(root, 'update.yml'))};
u.requestHeaders={Authorization:'token synthetic'};
u.disableDifferentialDownload=true;
u.autoInstallOnAppQuit=false;
u.autoDownload=true;
u.logger=null;
u.on('error',e=>{console.error(e.message);app.exit(1)});
const result=await u.checkForUpdates();
await result.downloadPromise;
console.log('VERIFIED_DOWNLOAD');
u.quitAndInstall(true,false);
}).catch(e=>{console.error(e.message);app.exit(1)});
`);
  const child = spawn(require('electron'), [root], { env: { ...fixture.env, APPIMAGE: old }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => errors += c);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Update integration timed out: ' + errors)); }, 90000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, errors);
  assert.match(output, /VERIFIED_DOWNLOAD/);
  assert.ok(requests.length >= 2 && requests.every(item => item.auth));
  const installed = stable ? old : path.join(installDir, feed.files[0].url);
  assert.equal(createHash('sha512').update(await readFile(installed)).digest('base64'), expected);
  if (!stable) await assert.rejects(readFile(old), { code: 'ENOENT' });
});
