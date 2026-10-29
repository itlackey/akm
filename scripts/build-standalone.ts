#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Build a standalone akm binary (`bun build --compile`):
 *
 *   bun scripts/build-standalone.ts --outfile <path> [--target <bun-target>] [--version <v>]
 *
 * The binary embeds no native code. Local semantic search loads ONNX Runtime from
 * akm's cache, where `akm setup` or the first local embedding fetches it
 * (`src/llm/embedders/onnx-runtime.ts`).
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
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
