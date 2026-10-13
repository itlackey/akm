// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Node entry for `akm-cli/api` (the package `exports` map points the default
// condition here; the `bun` condition points straight at `api.js`).
//
// `api.js` reaches modules that embed `.md`/`.xml` assets through
// `with { type: "text" }` imports, which Node cannot load without the
// text-import hook. Those imports are static and hoisted, so the hook must be
// registered before `api.js` is evaluated: register it, then import `api.js`
// dynamically. Same reason as `cli-node.mjs`.

import { register } from "node:module";

register("./text-import-hook.mjs", import.meta.url);

const { curate } = await import("./api.js");

export { curate };
