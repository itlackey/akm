import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const desktop = path.join(root, 'desktop');
const require = createRequire(import.meta.url);

test('Desktop runs the package built from this checkout, without changing the CLI package graph', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json')));
  const installed = path.dirname(require.resolve('akm-cli/package.json'));
  assert.equal(require('akm-cli/package.json').version, manifest.version);
  assert.equal(await readFile(path.join(installed, 'dist/workspace-node.mjs'), 'utf8'),
    await readFile(path.join(root, 'dist/workspace-node.mjs'), 'utf8'));
  assert.ok(!(await readdir(path.join(desktop, '.core'))).includes('desktop'));
  for (const name of ['electron', 'electron-updater', 'svelte', '@sveltejs/kit'])
    assert.ok(!manifest.dependencies[name] && !manifest.optionalDependencies[name]);
  assert.ok(!manifest.files.includes('desktop'));
});

test('application code uses only the approved workspace namespace and package metadata', async () => {
  for (const file of await readdir(path.join(desktop, 'src'), { recursive: true })) {
    if (!/\.(?:ts|mjs|js|svelte)$/.test(file)) continue;
    const source = await readFile(path.join(desktop, 'src', file), 'utf8');
    for (const match of source.matchAll(/['"](akm-cli[^'"]*)['"]/g))
      assert.ok(['akm-cli/workspace', 'akm-cli/package.json'].includes(match[1]), file + ': ' + match[1]);
  }
});
