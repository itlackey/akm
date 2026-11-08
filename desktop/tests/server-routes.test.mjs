// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { launchFixture } from "./support.mjs";

// The route table runs in the real server against a fixture built with the CLI. Each route reaches its operation;
// akm's own policy (revisions, leases, writability) is tested in akm, not here.
const ok = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
};
const ref = "personal//knowledge/restore-laptop";

test("every read route reaches its operation", async (t) => {
  const app = await launchFixture({ proposals: true, metrics: true, git: true });
  t.after(() => app.stop());
  const id = Object.values(app.proposals)[0];
  const q = (params) => `?${new URLSearchParams(params)}`;
  for (const route of [
    "/api/desktop",
    "/api/desktop/preferences",
    "/api/desktop/software",
    "/api/overview",
    "/api/overview/pulse",
    "/api/health",
    "/api/retrieval",
    "/api/improve/impact",
    "/api/meta",
    "/api/bundles",
    "/api/config",
    "/api/setup/detect",
    "/api/changes",
    "/api/proposals",
    "/api/proposals?status=recent",
    "/api/search/misses",
    "/api/search?q=restore&limit=3",
    `/api/bundles/files${q({ bundle: "personal" })}`,
    `/api/asset${q({ ref })}`,
    `/api/asset/history${q({ ref })}`,
    `/api/asset/related${q({ ref })}`,
    `/api/asset/improve${q({ ref })}`,
    `/api/tasks/history${q({ taskId: "none" })}`,
    `/api/proposals/${id}`,
  ])
    ok(await app.call(route));
  assert.equal(ok(await app.call("/api/bundles/files?bundle=personal")).entries.length > 0, true);
  assert.equal(ok(await app.call(`/api/proposals/${id}`)).proposal.id, id);
  assert.equal(ok(await app.call(`/api/asset/source${q({ ref })}`)).type, "knowledge");
  assert.equal((await app.call("/api/bundle/files?bundle=personal")).status, 404, "the old singular path is gone");
  assert.equal((await app.call("/api/fs/folders")).status, 404, "akm no longer lists host folders");
});

test("the folder dialog belongs to the Electron main process: outside it the route says so", async (t) => {
  const app = await launchFixture();
  t.after(() => app.stop());
  const outside = await app.call("/api/desktop/pick-folder", { start: "/tmp" });
  assert.deepEqual([outside.status, outside.body.code], [400, "FOLDER_DIALOG_FAILED"]);
  assert.match(outside.body.error, /AKM Desktop app/);
  const invalid = await app.call("/api/desktop/pick-folder", { start: 3 });
  assert.deepEqual([invalid.status, invalid.body.code], [400, "INVALID_FOLDER_DIALOG"]);
});

test("writes reach their operations and unknown fields are ignored", async (t) => {
  const app = await launchFixture({ proposals: true });
  t.after(() => app.stop());
  const { fresh, reject } = app.proposals;
  const source = ok(await app.call(`/api/asset/source?ref=${encodeURIComponent(ref)}`));
  ok(
    await app.call("/api/asset/save", {
      ref,
      revision: source.revision,
      content: `${source.content}\nMore.\n`,
      surprise: true,
    }),
  );
  const copy = ok(await app.call("/api/asset/copy", { sourceRef: ref, target: "personal", newName: "restore-copy" }));
  assert.equal(copy.overwritten, false);
  ok(await app.call("/api/knowledge/create", { bundle: "personal", name: "created-by-route", content: "# Created\n" }));
  ok(await app.call("/api/config/set", { set: { "output.format": "text" } }));
  ok(await app.call("/api/config/projects", { set: { "my.project": { paths: ["/work/mine"] } } }));
  assert.deepEqual(ok(await app.call("/api/config")).config.projects, { "my.project": { paths: ["/work/mine"] } });
  ok(
    await app.call("/api/config/projects", {
      set: { browse: { from: "personal", filters: { project: "none-here" } } },
    }),
  );
  const overview = ok(await app.call("/api/projects/overview?project=browse"));
  assert.deepEqual(
    overview.bundles.map((bundle) => [bundle.name, bundle.total.count > 0, bundle.eligible.count]),
    [["personal", true, 0]],
  );
  assert.deepEqual(ok(await app.call("/api/search?q=restore&project=browse&surprise=1")).hits, []);
  assert.equal((await app.call("/api/projects/overview?project=missing")).status, 400);
  ok(await app.call("/api/config/projects", { unset: ["browse", "my.project"] }));
  ok(
    await app.call("/api/config/set", {
      set: { "connections.lab": JSON.stringify({ endpoint: "http://127.0.0.1:9/v1", models: { fast: "m" } }) },
    }),
  );
  assert.deepEqual(
    ok(
      await app.call("/api/config/connections/save", {
        name: "lab",
        entry: { endpoint: "http://127.0.0.1:9/v1" },
        surprise: 1,
      }),
    ),
    { saved: true },
  );
  assert.equal(
    (
      await app.call("/api/config/connections/save", {
        name: "lab",
        entry: { endpoint: "http://x/v1", apiKey: "sk-literal" },
      })
    ).status,
    400,
  );
  assert.equal(ok(await app.call("/api/config")).defaultConnection, "lab");
  assert.deepEqual(ok(await app.call("/api/config/connections/remove", { name: "lab", surprise: true })), {
    saved: true,
    references: [],
    wasDefault: true,
    defaultConnection: null,
    stillInherited: false,
  });
  assert.equal((await app.call("/api/config/connections/remove", { name: "lab" })).status, 400);
  ok(await app.call("/api/bundles/settings", { bundle: "vendor", enabled: true }));
  ok(await app.call(`/api/proposals/${fresh}/reject`, { reason: "Synthetic" }));
  ok(await app.call(`/api/proposals/${fresh}/reopen`, {}));
  const batch = ok(await app.call("/api/proposals/reject", { ids: [reject, "no-such-proposal"], reason: "Synthetic" }));
  assert.deepEqual(
    batch.results.map((entry) => [entry.ok, entry.code]),
    [
      [true, undefined],
      [false, "PROPOSAL_NOT_FOUND"],
    ],
  );
  ok(await app.call(`/api/proposals/${fresh}/accept`, {}));
  ok(await app.call("/api/feedback", { ref, signal: "positive", reason: "Synthetic" }));
  const retired = ok(
    await app.call("/api/asset/retire", {
      ref: "personal//knowledge/restore-copy",
      revision: ok(await app.call("/api/asset/source?ref=personal%2F%2Fknowledge%2Frestore-copy")).revision,
    }),
  );
  ok(await app.call(`/api/proposals/${retired.proposalId}/revert`, {}));
});

test("one table maps an error to a status: conflict 409, usage 400, not found 404, read-only bundle 409", async (t) => {
  const app = await launchFixture({ proposals: true });
  t.after(() => app.stop());
  const { reject: first } = app.proposals;
  const stale = await app.call("/api/asset/save", { ref, revision: "0".repeat(64), content: "x" });
  assert.deepEqual([stale.status, stale.body.code, stale.body.ok], [409, "ASSET_CONTENT_CHANGED", false]);
  ok(await app.call(`/api/proposals/${first}/reject`, { reason: "Synthetic" }));
  const again = await app.call(`/api/proposals/${first}/accept`, {});
  assert.deepEqual([again.status, again.body.code], [409, "PROPOSAL_NOT_PENDING"]);
  assert.equal((await app.call("/api/asset")).status, 400);
  assert.equal((await app.call("/api/setup/apply", { dir: "relative" })).status, 400);
  assert.equal((await app.call("/api/proposals/no-such-proposal")).status, 404);
  const readOnly = await app.call("/api/desktop/sensitive/create", {
    bundle: "vendor",
    file: "env/new.env",
    content: "A=1\n",
  });
  assert.equal(readOnly.status, 409);
  assert.equal((await app.call("/api/nothing")).status, 404);
  const wrongType = await fetch(`${app.origin}/api/feedback`, {
    method: "POST",
    headers: { cookie: app.cookie, origin: app.origin, "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
});

test("an index written by a newer akm tells the user to update Desktop, not to upgrade akm", async (t) => {
  const app = await launchFixture({
    configureFixture: (fixture) => {
      // What a newer host CLI leaves behind: an index layout this engine does not understand.
      const db = new DatabaseSync(path.join(fixture.env.AKM_DATA_DIR, "index.db"));
      try {
        db.prepare("UPDATE index_meta SET value = '999' WHERE key = 'version'").run();
      } finally {
        db.close();
      }
    },
  });
  t.after(() => app.stop());
  const refused = await app.call("/api/search?q=restore&limit=3");
  assert.deepEqual([refused.status, refused.body.code], [409, "INDEX_SCHEMA_INCOMPATIBLE"]);
  assert.match(refused.body.error, /Update AKM Desktop/);
  assert.doesNotMatch(refused.body.error, /Upgrade akm/);
});
