// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import path from "node:path";
import { isBundleSlug } from "./asset/asset-ref";
import { UsageError } from "./errors";

/** Deterministic, filesystem-safe bundle slug from a source path. */
export function slugForPath(sourcePath: string): string {
  const resolved = path.resolve(sourcePath);
  const base = slugify(path.basename(resolved));
  if (base.length > 0) return base;
  return `bundle-${shortHash(resolved)}`;
}

/**
 * Bundle slug from the package/repo name a registry install id names
 * (`npm:@scope/pkg` → `pkg`, `github:owner/repo` → `repo`,
 * `git:https://host/owner/repo` → `repo`); empty when it names none.
 */
export function slugForRegistryId(registryId: string): string {
  const locator = registryId.slice(registryId.indexOf(":") + 1);
  return slugify(locator.split(/[/:]/).filter(Boolean).pop() ?? "");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Enforce the `--name` contract on every add path (D6): an explicit name is
 * not a silent hint that may fall back to a derived id — it is a request
 * that either succeeds exactly or fails loudly, before anything is written.
 *
 * `existingKeyForThisInstall` is the bundle key this exact source (path/URL/
 * registry id) is already configured under, if any. Re-adding that same
 * source under a *different* explicit name is rejected in favor of
 * `akm bundle rename`, which is the one command allowed to change a bundle's
 * key. A caller with no existing install for this source (the common case)
 * omits it.
 */
export function validateExplicitBundleName(
  bundles: Readonly<Record<string, unknown>>,
  name: string,
  existingKeyForThisInstall?: string,
): void {
  if (!isBundleSlug(name)) {
    throw new UsageError(
      `"${name}" is not a legal bundle name: it must not contain whitespace or the characters ":" "." "#" "/".`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (existingKeyForThisInstall !== undefined && name !== existingKeyForThisInstall) {
    throw new UsageError(
      `This source is already installed as bundle "${existingKeyForThisInstall}". Re-adding it under a ` +
        `different name is not supported — run \`akm bundle rename ${existingKeyForThisInstall} ${name}\` instead.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (name in bundles && name !== existingKeyForThisInstall) {
    throw new UsageError(
      `Bundle name "${name}" already exists. Choose another name, or run ` +
        `\`akm bundle rename ${name} <new-name>\` first.`,
      "INVALID_FLAG_VALUE",
    );
  }
}

/** Derive one batch-unique bundle id. */
export function deriveBundleId(registryId: string | undefined, sourcePath: string, usedIds: Set<string>): string {
  const preferred =
    registryId && registryId.length > 0 && isBundleSlug(registryId) ? registryId : slugForPath(sourcePath);
  const id = ensureUniqueId(preferred, sourcePath, usedIds);
  usedIds.add(id);
  return id;
}

/** Derive an ordered batch while reserving every explicit configured bundle id. */
export function deriveBundleIds(sources: readonly { registryId?: string; path: string }[]): string[] {
  const usedIds = new Set<string>();
  const reservedIds = new Set(
    sources.flatMap((source) => (source.registryId && isBundleSlug(source.registryId) ? [source.registryId] : [])),
  );
  return sources.map((source) => {
    const id =
      source.registryId && isBundleSlug(source.registryId)
        ? deriveBundleId(source.registryId, source.path, usedIds)
        : deriveBundleId(undefined, source.path, new Set([...usedIds, ...reservedIds]));
    usedIds.add(id);
    return id;
  });
}

function ensureUniqueId(preferred: string, sourcePath: string, used: Set<string>): string {
  if (!used.has(preferred)) return preferred;
  const suffixed = `${preferred}-${shortHash(path.resolve(sourcePath))}`;
  if (!used.has(suffixed)) return suffixed;
  let n = 2;
  while (used.has(`${suffixed}-${n}`)) n++;
  return `${suffixed}-${n}`;
}

/**
 * First 8 hex chars of `input`'s sha256 — deterministic and short enough to
 * suffix a slug or a path key. Exported so callers needing the same
 * short-hash-of-a-resolved-path primitive (e.g. `getStashStateKey` in
 * `paths.ts`) don't grow their own duplicate.
 */
export function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}
