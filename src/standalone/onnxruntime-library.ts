// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONNX Runtime shared library for a compiled standalone binary.
 *
 * `onnxruntime-node`'s addon links a shared library that sits beside it in the
 * package. A Bun executable extracts an embedded addon at load but not the
 * library it links, so the addon cannot start. The standalone build embeds the
 * library for its target (`src/standalone/native/`, chosen by
 * `scripts/build-standalone.ts`); this copies it once into akm's cache and
 * loads it with `bun:ffi`, after which the addon's own link to it is already
 * satisfied.
 *
 * Outside a standalone binary (`bun src/cli.ts`, the Node build) nothing here
 * is defined and nothing is evaluated: the package's own files are used.
 */

import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../core/paths";

// AKM_STANDALONE_NATIVE_MODULE and AKM_ONNXRUNTIME_VERSION ambient types are declared in globals.d.ts

interface EmbeddedLibrary {
  embeddedPath: string | undefined;
  fileName: string | undefined;
}

/**
 * Put the embedded library on disk and load it, before `onnxruntime-node` is
 * imported. Throws when the library cannot be loaded; the caller reports that
 * as the embedding runtime being unavailable.
 */
export async function preloadOnnxRuntimeLibrary(): Promise<void> {
  if (typeof AKM_STANDALONE_NATIVE_MODULE === "undefined") return;
  // The specifier is a build constant, so the standalone build bundles this one module and no other build bundles any.
  const { embeddedPath, fileName } = (await import(AKM_STANDALONE_NATIVE_MODULE)) as EmbeddedLibrary;
  if (!embeddedPath || !fileName) return;

  const directory = path.join(
    getCacheDir(),
    "onnxruntime",
    `${AKM_ONNXRUNTIME_VERSION}-${process.platform}-${process.arch}`,
  );
  const library = path.join(directory, fileName);
  if (!fs.existsSync(library) || fs.statSync(library).size !== fs.statSync(embeddedPath).size) {
    fs.mkdirSync(directory, { recursive: true });
    const partial = `${library}.${process.pid}.tmp`;
    fs.writeFileSync(partial, fs.readFileSync(embeddedPath));
    fs.renameSync(partial, library);
  }
  const { dlopen } = await import("bun:ffi");
  dlopen(library, { OrtGetApiBase: { args: [], returns: "ptr" } });
}
