// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// The secret to log in with: the one in the environment, else a fresh one printed below (a loopback dev server only).
const secret = process.env.AKM_WEB_SECRET || randomBytes(32).toString("hex");
const origin = "http://127.0.0.1:5173";
/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  AKM_WEB_SECRET: secret,
  AKM_DESKTOP_ORIGIN: origin,
  AKM_LAUNCHER_NODE: process.execPath,
};
delete env.AKM_LAUNCHER_PATH;
delete env.AKM_LAUNCHER_PID;
const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url))], {
  stdio: "inherit",
  env,
});
console.log(
  `Open ${origin} and log in with${process.env.AKM_WEB_SECRET ? " AKM_WEB_SECRET" : ` this secret: ${secret}`}`,
);
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.once(signal, () => child.kill(signal));
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
