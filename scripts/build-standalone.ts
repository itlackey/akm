#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Build a standalone akm binary (`bun build --compile`):
 *
 *   bun scripts/build-standalone.ts --outfile <path> [--target <bun-target>] [--version <v>]
 *
 * Two differences from a plain `bun build --compile`, both for the embedded
 * OpenCode (`@opencode/sdk`, #1244):
 *   - `@opencode-ai/pty` resolves its `opencode-pty` helper executable by
 *     package path when it is imported, which fails inside a compiled binary
 *     and would stop OpenCode from starting. It is replaced with its "no
 *     persistent terminal on this platform" value (`binaryPath` undefined).
 *     Agent runs do not use the persistent terminal; shell tools still run.
 *   - `@ff-labs/fff-bun` embeds its native file-finder library for the target
 *     platform, which is not installed when cross-compiling. It is resolved to
 *     "not available" (null), which its loader already handles; grep and glob
 *     run through ripgrep, not the file finder.
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { outfile: { type: "string" }, target: { type: "string" }, version: { type: "string" } },
});
if (!values.outfile) {
  console.error("usage: bun scripts/build-standalone.ts --outfile <path> [--target <bun-target>] [--version <v>]");
  process.exit(2);
}

const result = await Bun.build({
  entrypoints: ["./scripts/akm-standalone.ts"],
  compile: { outfile: values.outfile, ...(values.target ? { target: values.target as never } : {}) },
  ...(values.version ? { define: { AKM_VERSION: JSON.stringify(values.version) } } : {}),
  plugins: [
    {
      name: "embedded-opencode-natives",
      setup(build) {
        build.onResolve({ filter: /^@opencode-ai\/pty$/ }, () => ({ path: "pty", namespace: "akm-standalone" }));
        build.onResolve({ filter: /^@ff-labs\/fff-bin-/ }, () => ({ path: "fff-lib", namespace: "akm-standalone" }));
        build.onLoad({ filter: /^pty$/, namespace: "akm-standalone" }, () => ({
          contents: "export const binaryPath = undefined",
          loader: "js",
        }));
        build.onLoad({ filter: /^fff-lib$/, namespace: "akm-standalone" }, () => ({
          contents: "export default null",
          loader: "js",
        }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
