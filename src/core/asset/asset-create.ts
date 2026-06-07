// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared `--path` / `--name` semantics for asset-creating commands
 * (`remember`, `import`, `propose`, `workflow create`, ...).
 *
 * The contract, applied consistently across the command surface:
 *   - `--name` (or the name positional) is a FLAT asset name — no `/`.
 *   - `--path` is a relative directory, applied rooted at the asset's type
 *     directory. The final asset name is `<path>/<name>`.
 *
 * Subdirectory placement is `--path`'s job, not `--name`'s. System-derived
 * names (e.g. a URL-path-derived knowledge name) are exempt — only the user's
 * explicit name should be flat-checked, at the command layer.
 */

import { UsageError } from "../errors";

/**
 * Normalise an optional `--path` value: a relative directory, applied rooted
 * at the asset's type directory (e.g. `personal/projects` under `memories/`).
 * Rejects absolute paths and `.`/`..` segments. Returns `""` when unset.
 */
export function normalizeCreateSubPath(subPath: string | undefined): string {
  if (subPath === undefined) return "";
  const trimmed = subPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (trimmed.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new UsageError("--path must be a relative directory without '.' or '..' segments.");
  }
  return trimmed;
}

/**
 * Enforce that an explicit, user-supplied name is a flat (single-segment)
 * name. A `/` in the name is rejected with guidance to use `--path`. Applied
 * at the command layer to the user's name only — system-derived names may nest.
 */
export function assertFlatAssetName(name: string | undefined): void {
  if (name?.replace(/\\/g, "/").replace(/\.md$/i, "").includes("/")) {
    throw new UsageError(
      "Asset --name must be a flat name without '/'. Use --path to choose a subdirectory " +
        "(e.g. --path personal --name grocery-list).",
    );
  }
}

/**
 * Combine a normalised `--path` subdirectory with a flat base name into the
 * nested asset name the path resolver expects. `subPath` may be `""`.
 */
export function combineCreatePath(subPath: string, baseName: string): string {
  return subPath ? `${subPath}/${baseName}` : baseName;
}
