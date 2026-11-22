// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The pre-0.10 `bundles.<name>.components` form read as the flat bundle.
 *
 * A bundle had one component, which only ever repeated it: `components.<id>` held
 * the bundle's `adapter`, `root` and `writable`. One pure function, two call sites:
 * the loader runs it in memory on every read (`runConfigFilePipeline`, and the
 * `AKM_BUNDLE_DIR` raw read in `common.ts`) and `akm migrate apply` writes its
 * result back.
 */

import { ConfigError } from "../errors";

export interface ConvertBundleComponentsResult {
  readonly config: Record<string, unknown>;
  /** Whether `raw` held any `components`. */
  readonly changed: boolean;
  /** The bundles that held them. */
  readonly bundles: readonly string[];
}

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lift each bundle's one `components` entry onto the bundle; `raw` is returned as it is when no bundle has one.
 * `adapter` and `root` are set unless the bundle already names them (a key a newer akm wrote wins); `writable` is
 * set whenever the component has it, because that is what the reader honoured over the bundle's own. A `root` of
 * `.` is the default and is not carried.
 */
export function convertBundleComponents(raw: Record<string, unknown>): ConvertBundleComponentsResult {
  const bundles = raw.bundles;
  if (!isDict(bundles)) return { config: raw, changed: false, bundles: [] };
  const converted: string[] = [];
  const next: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(bundles)) {
    if (!isDict(entry) || !Object.hasOwn(entry, "components")) {
      next[name] = entry;
      continue;
    }
    const { components, ...flat } = entry;
    const only = isDict(components) ? Object.values(components) : [];
    if (only.length !== 1) {
      throw new ConfigError("A bundle components map must contain exactly one component.", "INVALID_CONFIG_FILE");
    }
    const component = only[0];
    if (isDict(component)) {
      if (flat.adapter === undefined && component.adapter !== undefined) flat.adapter = component.adapter;
      if (flat.root === undefined && component.root !== undefined && component.root !== ".") flat.root = component.root;
      if (component.writable !== undefined) flat.writable = component.writable;
    }
    next[name] = flat;
    converted.push(name);
  }
  if (converted.length === 0) return { config: raw, changed: false, bundles: [] };
  return { config: { ...raw, bundles: next }, changed: true, bundles: converted };
}
