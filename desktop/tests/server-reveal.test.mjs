// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { launchFixture } from "./support.mjs";

const secret =
  "synthetic-key-not-a-credential\nhttps://user:synthetic-password@example.test/?token=synthetic-token\n<script>window.__secretExecuted=true</script>\n";
const env = 'EXAMPLE_KEY="synthetic-key-not-a-credential"\nEXAMPLE_URL=https://user:synthetic-password@example.test/\n';
const value = (result) => {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.data;
};
async function fixture() {
  return launchFixture({
    configureFixture: async (fixture) => {
      for (const folder of ["env", "secrets"]) await fs.mkdir(path.join(fixture.root, "personal", folder));
      await fs.writeFile(path.join(fixture.root, "personal/secrets/example-key"), secret);
      await fs.writeFile(path.join(fixture.root, "personal/env/example.env"), env);
      await fs.writeFile(path.join(fixture.root, "personal/env/default.env"), env);
      execFileSync(process.execPath, [fixture.launcher, "index", "--full", "--format=json", "-q"], {
        env: fixture.env,
        stdio: "pipe",
      });
    },
  });
}

test("env and secrets open as metadata; only explicit authenticated reveal returns literal bytes", async (t) => {
  const app = await fixture();
  t.after(() => app.stop());
  for (const [ref, expected] of [
    ["personal//env/example", env],
    ["personal//env/default", env],
    ["personal//secrets/example-key", secret],
  ]) {
    const masked = value(await app.call(`/api/desktop/sensitive?ref=${encodeURIComponent(ref)}`));
    assert.ok(masked.name);
    assert.ok(masked.location);
    assert.ok(!JSON.stringify(masked).includes("synthetic-password"));
    const revealed = value(await app.call("/api/desktop/sensitive/reveal", { ref }));
    assert.equal(revealed.content, expected);
    assert.notEqual(
      (
        await fetch(`${app.origin}/api/desktop/sensitive/reveal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref }),
        })
      ).status,
      200,
    );
    const response = await fetch(`${app.origin}/api/desktop/sensitive/reveal`, {
      method: "POST",
      headers: { Cookie: app.cookie, Origin: app.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.notEqual(
      (
        await fetch(`${app.origin}/api/desktop/sensitive/reveal`, {
          method: "POST",
          headers: { Cookie: app.cookie, Origin: "https://outside.test", "Content-Type": "application/json" },
          body: JSON.stringify({ ref }),
        })
      ).status,
      200,
    );
  }
  assert.notEqual(
    (await app.call("/api/desktop/sensitive/reveal?ref=personal%2F%2Fsecrets%2Fexample-key")).status,
    200,
    "GET cannot reveal",
  );
  // A newly created file must also open from Files before an index rebuild.
  await fs.writeFile(path.join(app.root, "personal/env/unindexed.env"), env);
  const unindexed = value(await app.call("/api/desktop/sensitive?bundle=personal&file=env%2Funindexed.env"));
  assert.equal(unindexed.name, "unindexed.env");
  assert.equal(
    value(await app.call("/api/desktop/sensitive/reveal", { bundle: "personal", file: "env/unindexed.env" })).content,
    env,
  );
  for (const file of [
    "../shared/knowledge/shared-backup.md",
    "knowledge/restore-laptop.md",
    "env/../../config/config.json",
  ])
    assert.notEqual((await app.call("/api/desktop/sensitive/reveal", { bundle: "personal", file })).status, 200);
  await fs.symlink(app.documentPath, path.join(app.root, "personal/secrets/linked"));
  assert.notEqual(
    (await app.call("/api/desktop/sensitive/reveal", { bundle: "personal", file: "secrets/linked" })).status,
    200,
  );
  await fs.writeFile(path.join(app.root, "personal/secrets/binary"), Buffer.from([0, 255]));
  assert.notEqual(
    (await app.call("/api/desktop/sensitive/reveal", { bundle: "personal", file: "secrets/binary" })).status,
    200,
  );
  assert.ok(!app.logs().includes("synthetic-password"));
});
