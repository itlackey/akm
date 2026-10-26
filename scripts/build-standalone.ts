#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Build a standalone akm binary (`bun build --compile`):
 *
 *   bun scripts/build-standalone.ts --outfile <path> [--target <bun-target>] [--version <v>]
 *
 * Differences from a plain `bun build --compile`. The first three are for the
 * embedded OpenCode (`@opencode/sdk`, #1244):
 *   - `@ai-sdk/openai-compatible`, the package OpenCode reaches an
 *     OpenAI-compatible endpoint with, is embedded as a second entry
 *     (`scripts/ai-sdk-openai-compatible.ts`) and loaded by file URL at run
 *     time. Without it OpenCode installs the package from the npm registry on
 *     the binary's first run, which fails on a machine that cannot reach it.
 *   - `@opencode-ai/pty` resolves its `opencode-pty` helper executable by
 *     package path when it is imported, which fails inside a compiled binary
 *     and would stop OpenCode from starting. It is replaced with its "no
 *     persistent terminal on this platform" value (`binaryPath` undefined).
 *     Agent runs do not use the persistent terminal; shell tools still run.
 *   - `@ff-labs/fff-bun` embeds its native file-finder library for the target
 *     platform, which is not installed when cross-compiling. It is resolved to
 *     "not available" (null), which its loader already handles; grep and glob
 *     run through ripgrep, not the file finder.
 *   - Local semantic search needs the shared library `onnxruntime-node`'s addon
 *     links, which a Bun executable does not extract beside the addon. The
 *     library for the target is embedded by one of the `src/standalone/native/`
 *     modules, chosen here by the `AKM_STANDALONE_NATIVE_MODULE` define; the
 *     other modules are never bundled. See `src/standalone/onnxruntime-library.ts`.
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
  entrypoints: ["./scripts/akm-standalone.ts", "./scripts/ai-sdk-openai-compatible.ts"],
  compile: { outfile: values.outfile, ...(values.target ? { target: values.target as never } : {}) },
  define: {
    AKM_STANDALONE_NATIVE_MODULE: JSON.stringify(`./native/${nativeModule(values.target)}`),
    AKM_ONNXRUNTIME_VERSION: JSON.stringify(onnxruntimeVersion),
    ...(values.version ? { AKM_VERSION: JSON.stringify(values.version) } : {}),
  },
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
