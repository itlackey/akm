import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseRefusal } from '../scripts/release-guard.mjs';

test('an AppImage is built only from a clean tree at the release tag', () => {
  assert.equal(releaseRefusal({ version: '0.10.261105', dirty: false, tags: ['v0.10.261105', ''] }), null);
  assert.match(releaseRefusal({ version: '0.10.261105', dirty: true, tags: ['v0.10.261105'] }), /uncommitted/);
  assert.match(releaseRefusal({ version: '0.10.261105', dirty: false, tags: [''] }), /not tagged v0\.10\.261105/);
  assert.match(releaseRefusal({ version: '0.10.261105', dirty: false, tags: ['v0.10.261104'] }), /not tagged/);
});
