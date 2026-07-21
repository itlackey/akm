// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared ref-resolution helpers for the `env` and `secret` command families
 * (WS6). These were duplicated/co-located inline in `src/cli.ts`; hoisting them
 * here lets `src/commands/env/env-cli.ts` and `src/commands/env/secret-cli.ts` import a
 * single copy of the parse/resolve/make + path-traversal-guard logic (the WS6
 * "env traversal-guard copies 5 → 1" KPI). Behaviour is byte-identical to the
 * inline forms: env/secret VALUES are never read or surfaced here — these
 * helpers only resolve refs to absolute paths and guard against directory
 * traversal.
 */

import path from "node:path";
import { type SearchSource as IndexSearchSource, resolveSourceEntries } from "../indexer/search/search-source";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "./asset/asset-create";
import { assetPathForName } from "./asset/asset-placement";
import type { AssetRef } from "./asset/resolve-ref";
import { displayRef, isFullRefInput, parseRefInput } from "./asset/resolve-ref";
import { isWithin } from "./common";
import { loadConfig } from "./config/config";
import { NotFoundError, UsageError } from "./errors";

export type { IndexSearchSource };

/**
 * The `vault` asset type was removed in 0.9.0. The env/secret input path no
 * longer routes through the legacy stored-ref parser (which carries the removal
 * signpost), so a `vault:`/`vault/` leading token would otherwise be silently
 * qualified into an `env/vault:…` not-found. Detect it here and re-emit the
 * migration signpost so 0.8→0.9 muscle memory still gets pointed at env/secret.
 */
function assertNotRemovedVaultRef(ref: string): void {
  const boundary = ref.indexOf("//");
  const bare = boundary >= 0 ? ref.slice(boundary + 2) : ref;
  if (/^vault[:/]/.test(bare.trim())) {
    throw new UsageError(
      "The `vault` asset type was removed in 0.9.0 — use `env:` (whole .env config) or `secret:` (a single value).",
      "INVALID_FLAG_VALUE",
    );
  }
}

export function parseEnvRef(ref: string): AssetRef {
  // Accept a bare env name (`prod`, `sub/prod`) or the new-grammar
  // `[bundle//]env/name` conceptId. A bare name's leading segment maps to no
  // asset type, so it is qualified with the `env/` conceptId prefix; anything
  // already a full new-grammar ref is parsed as-is.
  assertNotRemovedVaultRef(ref);
  return parseRefInput(isFullRefInput(ref) ? ref : `env/${ref}`);
}

export function findEnvSource(origin: string | undefined): IndexSearchSource {
  const sources = resolveSourceEntries(undefined, loadConfig());
  if (sources.length === 0) {
    throw new UsageError("No stashes configured. Run `akm init` to create your working stash.");
  }
  if (!origin || origin === "local") return sources[0]!;
  const named = sources.find((source) => source.registryId === origin);
  if (!named) {
    throw new NotFoundError(`Source not found for origin: ${origin}`);
  }
  return named;
}

export function makeEnvRef(name: string, source?: IndexSearchSource): string {
  // F4b output-spelling flip: `env/name` in the primary stash, `bundle//env/name`
  // for a slug-clean named source.
  return displayRef({ type: "env", name, bundleId: source?.registryId });
}

/**
 * Resolve an env ref to an absolute `.env` path. Accepts `env:` and
 * `environment:` (alias) refs as well as bare names. The path is returned even
 * when the file does not yet exist (so `create` writes under `env/`).
 */
export function resolveEnvPath(ref: string): {
  name: string;
  absPath: string;
  source: IndexSearchSource;
  parsedRef: AssetRef;
  dir: "env";
} {
  const parsed = parseEnvRef(ref);
  if (parsed.type !== "env") {
    throw new UsageError(`Expected an env ref (env:<name>); got "${ref}".`);
  }
  const source = findEnvSource(parsed.origin);

  const envRoot = path.join(source.path, "env");
  const envPath = assetPathForName("env", envRoot, parsed.name);
  // Defense-in-depth: ensure the resolved path stays inside the env directory.
  // validateName already rejects traversal patterns like "../../foo", but an
  // absolute-path override or symlink-based attack could still escape without
  // this second check.
  if (!isWithin(envPath, envRoot)) {
    throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
  }

  return { name: parsed.name, absPath: envPath, source, parsedRef: parsed, dir: "env" };
}

export function parseSecretRef(ref: string): AssetRef {
  // Same bare-name-vs-full-ref rule as parseEnvRef; a bare name is qualified
  // with the `secrets/` conceptId prefix (secret's stash subdir).
  assertNotRemovedVaultRef(ref);
  return parseRefInput(isFullRefInput(ref) ? ref : `secrets/${ref}`);
}

export function makeSecretRef(name: string, source?: IndexSearchSource): string {
  // F4b output-spelling flip: `secrets/name` in the primary stash,
  // `bundle//secrets/name` for a slug-clean named source.
  return displayRef({ type: "secret", name, bundleId: source?.registryId });
}

export function resolveSecretPath(
  ref: string,
  // Create-only (`secret set`): enforce a flat ref name and apply `--path` as
  // the subdirectory. Lookup callers omit this so nested refs keep resolving.
  create?: { subPath?: string },
): {
  name: string;
  absPath: string;
  source: IndexSearchSource;
} {
  const parsed = parseSecretRef(ref);
  if (parsed.type !== "secret") {
    throw new UsageError(`Expected a secret ref (secret:<name>); got "${ref}".`);
  }
  if (create) {
    assertFlatAssetName(parsed.name);
    parsed.name = combineCreatePath(normalizeCreateSubPath(create.subPath), parsed.name);
  }
  // Source resolution is identical for every asset type; reuse the env helper.
  const source = findEnvSource(parsed.origin);
  const typeRoot = path.join(source.path, "secrets");
  const absPath = assetPathForName("secret", typeRoot, parsed.name);
  // Defense-in-depth: ensure the resolved path stays inside the secrets dir.
  if (!isWithin(absPath, typeRoot)) {
    throw new UsageError(`Secret name "${parsed.name}" escapes the secrets directory.`);
  }
  return { name: parsed.name, absPath, source };
}
