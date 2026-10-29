// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONNX Runtime the real-model tests share across runs, as they share the
 * model through HF_HOME: kept in the repo-local `.ci-cache/akm/onnxruntime/`,
 * which the gated jobs cache beside the model. `seedOnnxRuntime` copies it into a
 * test's akm cache before a run, so nothing is fetched; `keepOnnxRuntime` copies
 * back a folder a run fetched that the shared copy lacks.
 */

import fs from "node:fs";
import path from "node:path";

const SHARED = path.resolve(import.meta.dir, "..", "..", ".ci-cache", "akm", "onnxruntime");

/** Copy the shared ONNX Runtime folders, when there are any, into the akm cache directory `cacheDir`. */
export function seedOnnxRuntime(cacheDir: string): void {
  if (fs.existsSync(SHARED)) fs.cpSync(SHARED, path.join(cacheDir, "onnxruntime"), { recursive: true });
}

/** Copy each ONNX Runtime folder in the akm cache directory `cacheDir` that the shared copy lacks into it. */
export function keepOnnxRuntime(cacheDir: string): void {
  const fetched = path.join(cacheDir, "onnxruntime");
  if (!fs.existsSync(fetched)) return;
  for (const folder of fs.readdirSync(fetched)) {
    const kept = path.join(SHARED, folder);
    if (!fs.existsSync(kept)) fs.cpSync(path.join(fetched, folder), kept, { recursive: true });
  }
}
