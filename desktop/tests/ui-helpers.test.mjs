import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { title, bodyOf, assetSource, saveContent, toggleSelection, countAxis, matchesAssetRef, api, ApiError } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('Library selection matches canonical refs but never the same path in another bundle', () => {
  const local = { ref: 'knowledge/guide', origin: 'personal' };
  assert.equal(matchesAssetRef(local, 'personal//knowledge/guide', 'personal'), true);
  assert.equal(matchesAssetRef(local, 'knowledge/guide', 'personal'), true);
  assert.equal(matchesAssetRef(local, 'shared//knowledge/guide', 'personal'), false);
  assert.equal(matchesAssetRef({ ref: 'shared//knowledge/guide' }, 'knowledge/guide', 'personal'), false);
  assert.equal(matchesAssetRef({ ref: 'knowledge/guide' }, 'personal//knowledge/guide', ''), false);
});

test('asset bodies follow the current AKM UI contract, including command and agent bodies', () => {
  assert.equal(assetSource({ content: '# Knowledge' }), '# Knowledge');
  assert.equal(assetSource({ template: 'Review $ARGUMENTS' }), 'Review $ARGUMENTS');
  assert.equal(assetSource({ prompt: 'You are a reviewer.' }), 'You are a reviewer.');
  assert.equal(assetSource({ content: '', template: 'Fallback' }), 'Fallback');
  assert.equal(assetSource({ content: 'First', template: 'Second', prompt: 'Third' }), 'First');
  assert.equal(assetSource(), '');
});

test('count chart ticks are unique integers and match grid positions, even for one event', () => {
  assert.deepEqual(countAxis(1), { maximum: 1, ticks: [0, 1] });
  assert.deepEqual(countAxis(3), { maximum: 3, ticks: [0, 1, 2, 3] });
  assert.deepEqual(countAxis(7), { maximum: 8, ticks: [0, 2, 4, 6, 8] });
  for (const observed of [0, 1, 2, 9, 25, 99, 10001]) {
    const { maximum, ticks } = countAxis(observed);
    assert.equal(ticks.length, new Set(ticks).size);
    assert.ok(ticks.every(Number.isInteger));
    assert.ok(maximum >= observed);
    assert.ok(ticks.length <= 6);
    assert.equal(ticks.at(-1), maximum);
  }
});

test('human titles use actual title metadata, then readable name/ref fallback', () => {
  assert.equal(title({ ref: 'personal//knowledge/restore-laptop' }), 'restore laptop');
  assert.equal(title({ ref: 'knowledge/file', metadata: { title: 'Restore your laptop' } }), 'Restore your laptop');
  assert.equal(title({ ref: 'knowledge/file', metadata: { title: { unsafe: true } } }), 'file');
  assert.equal(title(), 'Untitled asset');
});
test('Markdown frontmatter removed only at beginning', () => {
  assert.equal(bodyOf('---\ntitle: Guide\n---\n# Content'), '# Content');
  assert.equal(bodyOf('# Content\n---\n'), '# Content\n---\n');
});
test('save keeps untouched bytes and uniform CRLF; never changes mixed line endings incidentally', () => {
  assert.equal(saveContent('a\r\nb\r\n', 'a\nb\n'), 'a\r\nb\r\n');
  assert.equal(saveContent('a\r\nb\r\n', 'new\nb\n'), 'new\r\nb\r\n');
  assert.equal(saveContent('a\r\nb\n', 'new\nb\n'), 'new\nb\n');
});
test('comparison selection has exactly two slots and removal preserves the other', () => {
  assert.deepEqual(toggleSelection(['a'], 'b', 2), ['a', 'b']);
  assert.deepEqual(toggleSelection(['a', 'b'], 'c', 2), ['a', 'b']);
  assert.deepEqual(toggleSelection(['a', 'b'], 'a', 2), ['b']);
});
test('transport unwraps the original AKM envelope once and encodes ref parameters', async (t) => {
  const original = globalThis.fetch;
  t.after(() => globalThis.fetch = original);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/asset?ref=personal%2F%2Fknowledge%2Fone');
    assert.deepEqual(options, {});
    return Response.json({ ok: true, data: { asset: { ref: 'personal//knowledge/one' } } });
  };
  assert.deepEqual(await api('/asset', { ref: 'personal//knowledge/one' }), { asset: { ref: 'personal//knowledge/one' } });
});
test('conflict error retains structured code needed by the draft recovery flow', async (t) => {
  const original = globalThis.fetch;
  t.after(() => globalThis.fetch = original);
  globalThis.fetch = async () => Response.json({ ok: false, code: 'ASSET_CONTENT_CHANGED', error: 'Changed on disk' }, { status: 409 });
  await assert.rejects(api('/desktop/file/save', {}, { content: 'draft' }), (error) => error instanceof ApiError && error.code === 'ASSET_CONTENT_CHANGED' && error.status === 409);
});
