#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Build a standalone akm binary (`bun build --compile`):
 *
 *   bun scripts/build-standalone.ts --outfile <path> [--target <bun-target>] [--version <v>]
 *
 * Differences from a plain `bun build --compile`: local semantic search needs
 * the shared library `onnxruntime-node`'s addon links, which a Bun executable
 * does not extract beside the addon. The library for the target is embedded by
 * one of the `src/standalone/native/` modules, chosen here by the
 * `AKM_STANDALONE_NATIVE_MODULE` define; the other modules are never bundled.
 * See `src/standalone/onnxruntime-library.ts`.
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { outfile: { type: "string" }, target: { type: "string" }, version: { type: "string" } },
});
if (!values.outfile) {
  console.error("usage: bun scripts/build-standalone.ts --outfile <path> [--target <bun-target>] [--version <v>]");
  process.exit(2);
}

/** The `src/standalone/native/` module for a build target (default: this machine); `none` where onnxruntime-node ships no library. */
function nativeModule(target: string | undefined): string {
  const [os, arch, ...variants] = target
    ? target.replace(/^bun-/, "").split("-")
    : [process.platform === "win32" ? "windows" : process.platform, process.arch];
  const module = `${os}-${arch}`;
  return !variants.includes("musl") && ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"].includes(module)
    ? module
    : "none";
}

const onnxruntimeVersion = (await Bun.file("./node_modules/onnxruntime-node/package.json").json()).version as string;

const result = await Bun.build({
  entrypoints: ["./scripts/akm-standalone.ts"],
  compile: { outfile: values.outfile, ...(values.target ? { target: values.target as never } : {}) },
  define: {
    AKM_STANDALONE_NATIVE_MODULE: JSON.stringify(`./native/${nativeModule(values.target)}`),
    AKM_ONNXRUNTIME_VERSION: JSON.stringify(onnxruntimeVersion),
    ...(values.version ? { AKM_VERSION: JSON.stringify(values.version) } : {}),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
