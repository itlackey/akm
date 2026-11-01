// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serves `akm ui` over the seeded visual dataset on a fixed port, with the
 * clock frozen at FIXED_NOW (plan 8.7). Run by Playwright's `webServer`:
 * `bun tests/visual/serve.ts`.
 */

import { setSystemTime } from "bun:test";
import { startUiServer } from "../../src/commands/ui/server";
import { akmIndex } from "../../src/indexer/indexer";
import { FIXED_NOW, VISUAL_PORT, VISUAL_TOKEN } from "./constants";
import { isolateEnvironment, writeConfig } from "./environment";
import { seedStash, seedVisualState } from "./seed";

setSystemTime(new Date(FIXED_NOW));

const stashDir = isolateEnvironment();
writeConfig(stashDir);
seedStash(stashDir);
await akmIndex({ stashDir, full: true });
seedVisualState(stashDir);

const server = await startUiServer({ port: VISUAL_PORT, token: VISUAL_TOKEN });
console.log(`akm ui (visual harness) listening on ${server.url}`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
