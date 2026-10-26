// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The files of a local embedding model, fetched from the Hugging Face Hub into
 * akm's model cache on first use. The layout is `<HF_HOME>/<repo>/<file>` (HF_HOME
 * defaults to `<akm cache>/models`), the one earlier releases wrote through
 * Transformers.js, so a cache they filled is reused as it is.
 */

import fs from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../../core/common";
import { getCacheDir } from "../../core/paths";
import { writeResponseToFileCapped } from "../../runtime";

/** `config.json` is not read here; releases that ran the model through Transformers.js require it, so it stays in the cache. */
const MODEL_FILES = ["tokenizer.json", "tokenizer_config.json", "config.json", "onnx/model.onnx"];

function isEnabledEnvironmentFlag(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

async function downloadFile(url: string, target: string): Promise<void> {
  const response = await fetchWithRetry(url, undefined, { timeout: 60_000 });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.tmp`;
  try {
    await writeResponseToFileCapped(partial, response);
    fs.renameSync(partial, target);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

/**
 * Make sure every file of `modelName` (a Hub repo id) is cached and return the
 * directory holding them. With `HF_HUB_OFFLINE` set nothing is fetched and a
 * missing file is an error.
 */
export async function ensureLocalModelFiles(modelName: string): Promise<string> {
  const modelDir = path.join(process.env.HF_HOME || path.join(getCacheDir(), "models"), ...modelName.split("/"));
  const offline = isEnabledEnvironmentFlag(process.env.HF_HUB_OFFLINE);
  for (const file of MODEL_FILES) {
    const target = path.join(modelDir, ...file.split("/"));
    if (fs.existsSync(target)) continue;
    if (offline) {
      throw new Error(`The local embedding model file ${target} is not cached and HF_HUB_OFFLINE is set.`);
    }
    await downloadFile(`https://huggingface.co/${modelName}/resolve/main/${file}`, target);
  }
  return modelDir;
}
