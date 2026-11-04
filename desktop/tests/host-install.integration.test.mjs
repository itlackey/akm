import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { createFixture } from '../scripts/fixture.mjs';
import { HostTools } from '../src/lib/server/features/host-tools.mjs';

test('official AKM installer creates and verifies a standalone CLI in an isolated home', {
  skip: process.env.AKM_DESKTOP_TEST_LIVE_INSTALL !== '1', timeout: 660000
}, async () => {
  const fixture = await createFixture({ index: false });
  const env = { ...fixture.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[key];
  const installed = path.join(env.HOME, '.local/bin/akm');
  const host = new HostTools({
    home: env.HOME, env,
    find: async name => {
      // Do not inspect or run any real host harness or pre-existing AKM.
      if (name !== 'akm') return undefined;
      try { await access(installed); return installed; } catch { return undefined; }
    }
  });
  host.start('install-cli'); await host.pending;
  const status = host.snapshot();
  assert.equal(status.error, undefined);
  assert.equal(status.cli.path, installed);
  assert.equal(status.cli.runnable, true);
  assert.match(status.cli.version, /^\d+\.\d+\.\d+/);
  console.log(JSON.stringify({ installedVersion: status.cli.version, updateAvailable: status.upgrade?.updateAvailable, isolatedHome: env.HOME }));
});
