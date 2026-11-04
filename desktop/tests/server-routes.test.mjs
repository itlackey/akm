import test from 'node:test';
import assert from 'node:assert/strict';
import { launchFixture } from './support.mjs';

// The route table runs in the real server against a fixture built with the CLI. Each route reaches its operation;
// akm's own policy (revisions, leases, writability) is tested in akm, not here.
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };
const ref = 'personal//knowledge/restore-laptop';

test('every read route reaches its operation', async t => {
  const app = await launchFixture({ proposals: true, metrics: true, git: true }); t.after(() => app.stop());
  const id = Object.values(app.proposals)[0];
  const q = params => '?' + new URLSearchParams(params);
  for (const route of ['/api/desktop', '/api/desktop/preferences', '/api/desktop/software', '/api/overview', '/api/overview/pulse',
    '/api/health', '/api/retrieval', '/api/improve/impact', '/api/meta', '/api/bundles', '/api/config', '/api/changes',
    '/api/proposals', '/api/proposals?status=recent', '/api/search/misses', '/api/search?q=restore&limit=3',
    '/api/bundles/files' + q({ bundle: 'personal' }), '/api/fs/folders' + q({ path: app.root }),
    '/api/asset' + q({ ref }), '/api/asset/history' + q({ ref }), '/api/asset/related' + q({ ref }),
    '/api/asset/improve' + q({ ref }), '/api/tasks/history' + q({ taskId: 'none' }), '/api/proposals/' + id ])
    ok(await app.call(route));
  assert.equal(ok(await app.call('/api/bundles/files?bundle=personal')).entries.length > 0, true);
  assert.equal(ok(await app.call('/api/proposals/' + id)).proposal.id, id);
  assert.equal(ok(await app.call('/api/asset/source' + q({ ref }))).type, 'knowledge');
  assert.equal((await app.call('/api/bundle/files?bundle=personal')).status, 404, 'the old singular path is gone');
});

test('writes reach their operations and unknown fields are ignored', async t => {
  const app = await launchFixture({ proposals: true }); t.after(() => app.stop());
  const { fresh, reject } = app.proposals;
  const source = ok(await app.call('/api/asset/source?ref=' + encodeURIComponent(ref)));
  ok(await app.call('/api/asset/save', { ref, revision: source.revision, content: source.content + '\nMore.\n', surprise: true }));
  const copy = ok(await app.call('/api/asset/copy', { sourceRef: ref, target: 'personal', newName: 'restore-copy' }));
  assert.equal(copy.overwritten, false);
  ok(await app.call('/api/knowledge/create', { bundle: 'personal', name: 'created-by-route', content: '# Created\n' }));
  ok(await app.call('/api/config/set', { set: { 'output.format': 'text' } }));
  ok(await app.call('/api/bundles/settings', { bundle: 'vendor', enabled: true }));
  ok(await app.call('/api/proposals/' + fresh + '/reject', { reason: 'Synthetic' }));
  ok(await app.call('/api/proposals/' + fresh + '/reopen', {}));
  const batch = ok(await app.call('/api/proposals/reject', { ids: [reject, 'no-such-proposal'], reason: 'Synthetic' }));
  assert.deepEqual(batch.results.map(entry => [entry.ok, entry.code]), [[true, undefined], [false, 'PROPOSAL_NOT_FOUND']]);
  ok(await app.call('/api/proposals/' + fresh + '/accept', {}));
  ok(await app.call('/api/feedback', { ref, signal: 'positive', reason: 'Synthetic' }));
  const retired = ok(await app.call('/api/asset/retire', { ref: 'personal//knowledge/restore-copy', revision: ok(await app.call('/api/asset/source?ref=personal%2F%2Fknowledge%2Frestore-copy')).revision }));
  ok(await app.call('/api/proposals/' + retired.proposalId + '/revert', {}));
});

test('one table maps an error to a status: conflict 409, usage 400, not found 404, read-only bundle 409', async t => {
  const app = await launchFixture({ proposals: true }); t.after(() => app.stop());
  const { reject: first } = app.proposals;
  const stale = await app.call('/api/asset/save', { ref, revision: '0'.repeat(64), content: 'x' });
  assert.deepEqual([stale.status, stale.body.code, stale.body.ok], [409, 'ASSET_CONTENT_CHANGED', false]);
  ok(await app.call('/api/proposals/' + first + '/reject', { reason: 'Synthetic' }));
  const again = await app.call('/api/proposals/' + first + '/accept', {});
  assert.deepEqual([again.status, again.body.code], [409, 'PROPOSAL_NOT_PENDING']);
  assert.equal((await app.call('/api/asset')).status, 400);
  assert.equal((await app.call('/api/proposals/no-such-proposal')).status, 404);
  const readOnly = await app.call('/api/desktop/sensitive/create', { bundle: 'vendor', file: 'env/new.env', content: 'A=1\n' });
  assert.equal(readOnly.status, 409);
  assert.equal((await app.call('/api/nothing')).status, 404);
  const wrongType = await fetch(app.origin + '/api/feedback', { method: 'POST', headers: { cookie: app.cookie, origin: app.origin, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
});
