#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Node entry wrapper for akm.
//
// The primary entry `dist/cli.js` carries a `#!/usr/bin/env bun` shebang and,
// when run under Node, relies on a text-import loader hook for its embedded
// `.md`/`.xml` assets (Bun loads those natively; Node needs a hook). Those
// imports are static and hoisted, so the hook MUST be registered before the
// module graph is evaluated — i.e. before `cli.js` is imported. This wrapper
// does exactly that: register the hook, then dynamically import the real CLI.
//
// Bun users never touch this file; it exists solely so `node dist/cli-node.mjs`
// (and the `test:node-smoke` script / Node CI matrix) can run akm end-to-end.

import { register } from "node:module";

register("./text-import-hook.mjs", import.meta.url);

// cli.js gates its startup block on `import.meta.main`, which is false when we
// `import()` it here. Opt in explicitly so the CLI actually runs `runMain`.
process.env.AKM_NODE_ENTRY = "1";

await import("./cli.js");
