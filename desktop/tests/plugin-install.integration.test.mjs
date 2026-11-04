// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "../scripts/fixture.mjs";
import { findProgram, HostTools, hostEnvironment, runHost } from "../src/lib/server/features/host-tools.ts";

test("native harness installers configure AKM only in isolated homes", {
  skip: process.env.AKM_DESKTOP_TEST_LIVE_PLUGINS !== "1",
  timeout: 600000,
}, async (t) => {
  const programs = await hostEnvironment();
  const found = Object.fromEntries(
    await Promise.all(
      ["akm", "bun", "claude", "codex", "opencode", "opencode2"].map(async (name) => [
        name,
        await findProgram(name, programs),
      ]),
    ),
  );
  for (const id of ["claude", "codex", "opencode", "opencode2"])
    await t.test(id, { skip: !found[id] }, async () => {
      const fixture = await createFixture({ index: false });
      t.after(() => fixture.cleanup());
      const env = { ...fixture.env };
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[key];
      const host = new HostTools({
        home: env.HOME,
        env,
        find: async (name) => (["akm", "bun", id].includes(name) ? found[name] : undefined),
        run: async (...args) => {
          // Report only a native exit code, never raw environment or credentials.
          try {
            return await runHost(...args);
          } catch (error) {
            console.log(JSON.stringify({ harness: id, command: args[1], exitCode: error.code }));
            throw error;
          }
        },
      });
      host.start("install-plugin", id, "next");
      await host.pending;
      assert.equal(host.snapshot().error, undefined);
      const plugin = host.snapshot().harnesses.find((item) => item.id === id)?.plugin;
      assert.ok(["installed", "configured"].includes(plugin?.state));
      console.log(JSON.stringify({ harness: id, plugin, isolatedHome: env.HOME }));
    });
});
