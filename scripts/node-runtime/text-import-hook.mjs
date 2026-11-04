// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Node ESM loader hook: support `import x from "./foo.md" with { type: "text" }`.
//
// Bun has a built-in text loader; Node does not (it only understands
// `type: "json"`). akm embeds prompt/template assets via `with { type: "text" }`
// imports that are statically hoisted into the module graph, so Node fails at
// load time with ERR_UNKNOWN_FILE_EXTENSION / unsupported import attribute
// before any command runs. This hook makes Node treat those imports as a module
// whose default export is the file's UTF-8 contents — byte-identical to Bun's
// text loader. It is ONLY registered on the Node entry path (see cli-node.mjs);
// Bun never loads it, so the Bun runtime is untouched.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".md", ".xml", ".txt", ".sql", ".yaml", ".yml"]);

function isTextImport(url, importAttributes) {
  if (importAttributes && importAttributes.type === "text") return true;
  const i = url.lastIndexOf(".");
  if (i === -1) return false;
  return TEXT_EXTENSIONS.has(url.slice(i).toLowerCase().split("?")[0]);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && isTextImport(url, context.importAttributes)) {
    const text = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  }
  return nextLoad(url, context);
}

// Node validates import attributes against the resolved format and rejects an
// unknown `type: "text"` during resolution. Strip the attribute here so our
// `load` hook (above) can take over; the assertion has already served its
// purpose of routing to text handling.
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.importAttributes && result.importAttributes.type === "text") {
    const { type, ...rest } = result.importAttributes;
    return { ...result, importAttributes: rest };
  }
  return result;
}
