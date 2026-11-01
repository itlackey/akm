// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serves `akm ui` over one seeded visual dataset on its fixed port, with the
 * clock frozen at FIXED_NOW (plan 8.7). Run by Playwright's `webServer`:
 * `bun tests/visual/serve.ts <profile>`, where profile is a key of PROFILES.
 */

import { setSystemTime } from "bun:test";
import { startUiServer } from "../../src/commands/ui/server";
import { akmIndex } from "../../src/indexer/indexer";
import { FIXED_NOW, PROFILES, type Profile, VISUAL_TOKEN } from "./constants";
import { isolateEnvironment, writeConfig } from "./environment";
import { seedLongContent, seedLowData, seedStash, seedVisualState } from "./seed";

const profile = (process.argv[2] ?? "loaded") as Profile;
if (!(profile in PROFILES))
  throw new Error(`Unknown visual profile "${profile}". Use one of ${Object.keys(PROFILES)}.`);

setSystemTime(new Date(FIXED_NOW));

const stashDir = isolateEnvironment(profile);
// `empty` is a fresh sandbox and `low-data` a quiet one that was never configured: the stash comes from AKM_BUNDLE_DIR.
writeConfig(stashDir, profile === "loaded" || profile === "long-content");
if (profile === "loaded") seedStash(stashDir);
if (profile === "low-data") seedLowData(stashDir);
if (profile === "long-content") seedLongContent(stashDir);
await akmIndex({ stashDir, full: true });
if (profile === "loaded") seedVisualState(stashDir);

const server = await startUiServer({ port: PROFILES[profile], token: VISUAL_TOKEN });
console.log(`akm ui (visual harness, ${profile}) listening on ${server.url}`);

// A harness-wide stop leaves every spec refused; name it on stderr, which the config pipes into the run log.
// Signals are logged, never ignored: a closed terminal or a quit must still end the server and free its port.
const tag = `[visual-serve ${profile}]`;
process.on("exit", (code) => console.error(`${tag} exit code=${code}`));
process.on("uncaughtException", (error) => {
  console.error(`${tag} uncaughtException`, error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`${tag} unhandledRejection`, reason);
  process.exit(1);
});

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", () => {
  console.error(`${tag} SIGTERM`);
  void stop();
});
process.on("SIGINT", () => {
  console.error(`${tag} SIGINT`);
  void stop();
});
