// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared ref-resolution helpers for the `env` and `secret` command families
 * (WS6). These were duplicated/co-located inline in `src/cli.ts`; hoisting them
 * here lets `src/commands/env-cli.ts` and `src/commands/secret-cli.ts` import a
 * single copy of the parse/resolve/make + path-traversal-guard logic (the WS6
 * "env traversal-guard copies 5 → 1" KPI). Behaviour is byte-identical to the
 * inline forms: env/secret VALUES are never read or surfaced here — these
 * helpers only resolve refs to absolute paths and guard against directory
 * traversal.
 */

import path from "node:path";
import { type SearchSource as IndexSearchSource, resolveSourceEntries } from "../indexer/search/search-source";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "./asset/asset-create";
import { parseAssetRef } from "./asset-ref";
import { resolveAssetPathFromName } from "./asset-spec";
import { isWithin } from "./common";
import { loadConfig } from "./config";
import { NotFoundError, UsageError } from "./errors";

export type { IndexSearchSource };

export function parseEnvRef(ref: string): ReturnType<typeof parseAssetRef> {
  return parseAssetRef(ref.includes(":") ? ref : `env:${ref}`);
}

export function findEnvSource(origin: string | undefined): IndexSearchSource {
  const sources = resolveSourceEntries(undefined, loadConfig());
  if (sources.length === 0) {
    throw new UsageError("No stashes configured. Run `akm init` to create your working stash.");
  }
  if (!origin || origin === "local") return sources[0];
  const named = sources.find((source) => source.registryId === origin);
  if (!named) {
    throw new NotFoundError(`Source not found for origin: ${origin}`);
  }
  return named;
}

export function makeEnvRef(name: string, source?: IndexSearchSource): string {
  return source?.registryId ? `${source.registryId}//env:${name}` : `env:${name}`;
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
  parsedRef: ReturnType<typeof parseAssetRef>;
  dir: "env";
} {
  const parsed = parseEnvRef(ref);
  if (parsed.type !== "env") {
    throw new UsageError(`Expected an env ref (env:<name>); got "${ref}".`);
  }
  const source = findEnvSource(parsed.origin);

  const envRoot = path.join(source.path, "env");
  const envPath = resolveAssetPathFromName("env", envRoot, parsed.name);
  // Defense-in-depth: ensure the resolved path stays inside the env directory.
  // validateName already rejects traversal patterns like "../../foo", but an
  // absolute-path override or symlink-based attack could still escape without
  // this second check.
  if (!isWithin(envPath, envRoot)) {
    throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
  }

  return { name: parsed.name, absPath: envPath, source, parsedRef: parsed, dir: "env" };
}

export function parseSecretRef(ref: string): ReturnType<typeof parseAssetRef> {
  return parseAssetRef(ref.includes(":") ? ref : `secret:${ref}`);
}

export function makeSecretRef(name: string, source?: IndexSearchSource): string {
  return source?.registryId ? `${source.registryId}//secret:${name}` : `secret:${name}`;
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
  const absPath = resolveAssetPathFromName("secret", typeRoot, parsed.name);
  // Defense-in-depth: ensure the resolved path stays inside the secrets dir.
  if (!isWithin(absPath, typeRoot)) {
    throw new UsageError(`Secret name "${parsed.name}" escapes the secrets directory.`);
  }
  return { name: parsed.name, absPath, source };
}
