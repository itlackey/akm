// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared ref-resolution helpers for the `env` and `secret` command families
 * (WS6). These were duplicated/co-located inline in `src/cli.ts`; hoisting them
 * here lets `src/commands/env/env-cli.ts` and `src/commands/env/secret-cli.ts` import a
 * single copy of the parse/resolve/make + path-traversal-guard logic (the WS6
 * "env traversal-guard copies 5 → 1" KPI). Every env file and secret is found,
 * read and written through its bundle's adapter. The only value read here is a
 * secret's, for the callers that inject it ({@link readSecret}); no value is
 * surfaced.
 */

import path from "node:path";
import { type SearchSource as IndexSearchSource, resolveSourceEntries } from "../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import type { AssetChange } from "./adapter/bundle-adapter";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "./asset/asset-create";
import { stashDirFor } from "./asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "./asset/asset-ref";
import type { AssetRef } from "./asset/resolve-ref";
import { conceptIdFromTypeName, displayRef } from "./asset/resolve-ref";
import { type Asset, findAsset, listAssets } from "./assets/read";
import { writeAssets } from "./assets/write";
import { scanEnvKeyNames } from "./common";
import { type AkmConfig, loadConfig } from "./config/config";
import { NotFoundError, UsageError } from "./errors";
import { resolveMutationTarget } from "./mutation-target";
import { formatRefForMessage, type ResolvedWriteTarget } from "./write-source";

export { sensitiveMarkerPath } from "./adapter/adapters/akm-format";
export type { IndexSearchSource };

/**
 * Every listed env asset with its key names (never values or comments). Moved
 * here from `commands/env/env-cli.ts` (#950) so `commands/health` can reuse it
 * to name which env asset supplies a credential's variable. `config` defaults to
 * the real `loadConfig()`; `commands/health` passes its own resolved config.
 */
export function listEnvsRecursive(
  config: AkmConfig = loadConfig(),
): Array<{ ref: string; path?: string; keys: string[] }> {
  return listAssets({ sources: resolveSourceEntries(undefined, config), type: "env" }).map(
    ({ conceptId, source, entry }) => ({
      ref: makeEnvRef(conceptId, source, config),
      ...(entry.file !== undefined ? { path: entry.file } : {}),
      keys: scanEnvKeyNames(entry.content()),
    }),
  );
}

/** Every listed secret, by ref. Its value is not read. */
export function listSecrets(config: AkmConfig = loadConfig()): Array<{ ref: string; path?: string }> {
  return listAssets({ sources: resolveSourceEntries(undefined, config), type: "secret" }).map(
    ({ conceptId, source, entry }) => ({
      ref: makeSecretRef(conceptId, source),
      ...(entry.file !== undefined ? { path: entry.file } : {}),
    }),
  );
}

export function parseEnvRef(ref: string): AssetRef {
  return parseTypedRef(ref, "env", "env/<name>");
}

/**
 * Parse `ref` as the placement address of a NEW (or canonically placed) asset of
 * the type the command names: `[bundle//]<type folder>/<name>`. The type is the
 * command's, not read from the ref. There is no bare-name form: `prod` is a
 * usage error that also names the ref it probably meant (`env/prod`), as text
 * only — the suggestion is never resolved or accepted.
 */
function parseTypedRef(ref: string, type: "env" | "secret", form: string): AssetRef {
  const parsed = parseBundleRef(ref);
  const prefix = `${stashDirFor(type)}/`;
  if (parsed.fragment !== undefined || !parsed.conceptId.startsWith(prefix) || parsed.conceptId === prefix) {
    const hint =
      parsed.fragment === undefined && !parsed.conceptId.includes("/")
        ? ` Did you mean "${makeBundleRef(parsed.bundle, conceptIdFromTypeName(type, parsed.conceptId))}"?`
        : "";
    throw new UsageError(
      `Expected ${type === "env" ? "an" : "a"} ${type} ref (${form} or <bundle>//${form}); got "${ref}". Write the full ref.${hint}`,
      "INVALID_FLAG_VALUE",
    );
  }
  return { type, name: parsed.conceptId.slice(prefix.length), origin: parsed.bundle };
}

/**
 * The owner of a read ref of the given type. The ref is the file's path inside
 * its bundle, so it may sit anywhere: what makes it an env or a secret is the
 * owning file, not the ref's first folder.
 */
function ownerOfType(ref: string, type: "env" | "secret", form: string): { asset: Asset; conceptId: string } {
  const parsed = parseBundleRef(ref);
  const asset = parsed.fragment === undefined ? findEnvSecretOwner(parsed.bundle, parsed.conceptId) : undefined;
  if (!asset) {
    // Not owned: a typed placement address reads as "not found", anything else as the wrong kind of ref.
    parseTypedRef(ref, type, form);
    throw new NotFoundError(`${type === "env" ? "Env" : "Secret"} not found: ${ref}`);
  }
  if (asset.type !== type) {
    throw new UsageError(
      `Expected ${type === "env" ? "an" : "a"} ${type} ref (${form} or <bundle>//${form}); got "${ref}". Write the full ref.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return { asset, conceptId: asset.conceptId };
}

/** The bundle and file that own an env or secret ref right now, or undefined. Sensitive files resolve too. */
function findEnvSecretOwner(origin: string | undefined, conceptId: string): Asset | undefined {
  return findAsset(
    { bundle: origin, conceptId },
    { sources: resolveSourceEntries(undefined, loadConfig()), unlisted: true },
  );
}

/**
 * The file that owns any asset ref right now (the asset type its conceptId
 * names, and the bundle-qualified spelling of the ref), or undefined when no
 * bundle owns it. The lookup behind `${ref}` tokens.
 */
export function resolveRefOwner(ref: string):
  | {
      /** The file that holds the asset; absent when the bundle keeps it elsewhere. */
      absPath: string | undefined;
      type: string;
      ref: string;
      /** The owner's value when it is a secret (`type: "secret"`), trimmed. Never print or log it. */
      secretValue: () => string;
    }
  | undefined {
  const { bundle, conceptId } = parseBundleRef(ref);
  const asset = findEnvSecretOwner(bundle, conceptId);
  return (
    asset && {
      absPath: asset.entry.file,
      type: asset.type,
      ref: makeBundleRef(asset.bundle, conceptId),
      secretValue: () => secretValue(asset),
    }
  );
}

/**
 * A secret's value: its content as its adapter reads it, with surrounding
 * whitespace trimmed, so a hand-written file's trailing newline never lands in
 * an HTTP header. The one read every consumer uses.
 */
function secretValue(asset: Asset): string {
  return asset.entry.content().trim();
}

/**
 * Is `bundle` the id of an installed bundle in the active source set? The predicate `${ref}` substitution uses to
 * tell a qualified ref from shell text. A source set that cannot be read (for example `AKM_BUNDLE_DIR` naming a
 * disabled bundle) answers "not installed", so shell text never raises a config error; a real ref then fails where
 * it is resolved, with that error.
 */
export function isInstalledBundle(bundle: string): boolean {
  try {
    return resolveSourcesForOrigin(bundle, resolveSourceEntries(undefined, loadConfig())).length > 0;
  } catch {
    return false;
  }
}

/**
 * `config` defaults to the real `loadConfig()`, same as {@link displayDefaultBundle}.
 * `listEnvsRecursive` threads its own (possibly injected) config through here so a
 * caller-supplied config governs ref display the same way it governs which stashes
 * get walked — otherwise this would silently fall back to reading the real config a
 * second time even when the walk itself honoured an injected one.
 */
export function makeEnvRef(conceptId: string, source?: IndexSearchSource, config: AkmConfig = loadConfig()): string {
  // F4b output-spelling flip: `env/name` in the primary stash, `bundle//env/name`
  // for a slug-clean named source.
  return displayRef({ conceptId, bundleId: source?.registryId }, displayDefaultBundle(source, config));
}

/**
 * Resolve an env ref to the absolute `.env` path that owns it right now.
 * Accepts a full `[bundle//]env/<name>` ref.
 * Throws `NotFoundError` when no bundle owns it; creating one goes through
 * {@link resolveEnvWriteTarget}.
 */
export function resolveEnvPath(ref: string): {
  /** The env's ref (conceptId), as the owning bundle spells it. */
  conceptId: string;
  /** The file that holds the env; absent when the bundle keeps it elsewhere. */
  absPath: string | undefined;
  /** The env's path inside its bundle. */
  relPath: string;
  source: IndexSearchSource;
  /** The bundle that owns the env file. */
  bundleId: string;
  dir: "env";
  /** The env file's text, as its adapter reads it. Never print or log it. */
  content: () => string;
} {
  const { asset, conceptId } = ownerOfType(ref, "env", "env/<name>");
  return {
    conceptId,
    absPath: asset.entry.file,
    relPath: asset.entry.relPath,
    source: asset.source,
    bundleId: asset.bundle,
    dir: "env",
    content: () => asset.entry.content(),
  };
}

export function parseSecretRef(ref: string): AssetRef {
  return parseTypedRef(ref, "secret", "secrets/<name>");
}

export function makeSecretRef(conceptId: string, source?: IndexSearchSource): string {
  // F4b output-spelling flip: `secrets/name` in the primary stash,
  // `bundle//secrets/name` for a slug-clean named source.
  return displayRef({ conceptId, bundleId: source?.registryId }, displayDefaultBundle(source));
}

function displayDefaultBundle(source?: IndexSearchSource, config: AkmConfig = loadConfig()): string | undefined {
  if (config.defaultBundle || !source) return config.defaultBundle;
  const primary = resolveSourceEntries(undefined, config)[0];
  return primary && path.resolve(primary.path) === path.resolve(source.path) ? source.registryId : undefined;
}

export function resolveSecretPath(ref: string): {
  conceptId: string;
  /** The file that holds the secret; absent when the bundle keeps it elsewhere. */
  absPath: string | undefined;
  /** The secret's path inside its bundle. */
  relPath: string;
  source: IndexSearchSource;
  /** The secret's raw content, as its adapter reads it. Never print or log it. */
  content: () => string;
} {
  const { asset, conceptId } = ownerOfType(ref, "secret", "secrets/<name>");
  const { entry } = asset;
  return {
    conceptId,
    absPath: entry.file,
    relPath: entry.relPath,
    source: asset.source,
    content: () => entry.content(),
  };
}

/**
 * Read the secret `ref` names: its trimmed value, and the bundle that owns it.
 * Callers MUST NOT write the value to stdout or any log.
 */
export function readSecret(ref: string): { conceptId: string; source: IndexSearchSource; value: string } {
  const { asset, conceptId } = ownerOfType(ref, "secret", "secrets/<name>");
  return { conceptId, source: asset.source, value: secretValue(asset) };
}

// ── Write-target resolution (env/secret mutations) ───────────────────────────
//
// READS (`env run`/`show`/`path`, `secret run`) ask the one ref-to-file walk
// (`findAsset`) above. (`secret path` used this same read-side
// resolver too, until it was REMOVED from the CLI in 0.9.0 — R-027 / D-49 — with
// `secret remove`, which resolved through the WRITE-target path below, so the two
// could silently name different files for the same ref. `secret remove` is back
// in 0.10, shaped like `env remove`: write-target resolution only.) WRITES route
// through the canonical `resolveWriteTarget` selection every other write command
// (remember/import/tasks/knowledge) shares: explicit `--bundle` wins, else
// `defaultWriteTarget`, else the working stash, and the chosen source must be
// writable (a non-writable `--bundle`/`defaultWriteTarget` fails fast with the
// shared typed ConfigError). Env/secret VALUES are still never read or surfaced
// here — these helpers only resolve the write target and the absolute path.

export interface EnvSecretWriteResolution {
  type: "env" | "secret";
  /** The name within the type (`prod` for `env/prod`). */
  name: string;
  /** The asset's concept id in the target bundle. */
  conceptId: string;
  target: ResolvedWriteTarget;
  ref: string;
}

/**
 * Resolve the destination of an env or secret mutation: an explicit
 * `--bundle`, else `defaultWriteTarget`, else the working bundle, whose adapter
 * must write the type. `create` enforces a flat ref name and applies `--path`
 * as the subdirectory.
 */
function resolveEnvSecretWriteTarget(
  type: "env" | "secret",
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): EnvSecretWriteResolution {
  const parsed = type === "env" ? parseEnvRef(ref) : parseSecretRef(ref);
  if (create) {
    assertFlatAssetName(parsed.name);
    parsed.name = combineCreatePath(normalizeCreateSubPath(create.subPath), parsed.name);
  }
  const resolved = resolveMutationTarget(loadConfig(), parsed, writeTarget);
  return {
    type,
    name: parsed.name,
    conceptId: conceptIdFromTypeName(type, parsed.name),
    target: resolved.target,
    ref: resolved.displayRef,
  };
}

export function resolveEnvWriteTarget(
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): EnvSecretWriteResolution {
  return resolveEnvSecretWriteTarget("env", ref, writeTarget, create);
}

export function resolveSecretWriteTarget(
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): EnvSecretWriteResolution {
  return resolveEnvSecretWriteTarget("secret", ref, writeTarget, create);
}

/** The env file or secret a write resolution names, as the target bundle's adapter reads it; undefined when it has none. */
export function findWriteTargetAsset(resolution: EnvSecretWriteResolution): Asset | undefined {
  const { source } = resolution.target;
  return findAsset(
    { conceptId: resolution.conceptId },
    {
      sources: [
        {
          path: source.path,
          registryId: source.name,
          ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
          ...(source.location !== undefined ? { location: source.location } : {}),
        },
      ],
      unlisted: true,
    },
  );
}

/**
 * Create, update or delete the env file or secret a resolution names, through
 * the target bundle's adapter, as one operation committed at the target's
 * boundary.
 */
export function writeEnvSecret(
  resolution: EnvSecretWriteResolution,
  operation:
    | { op: "create"; content: string | Buffer; sensitive?: boolean; exclusive?: boolean }
    | { op: "update"; content: string | Buffer; revision?: string }
    | { op: "delete"; revision?: string },
): AssetChange {
  const { type, name, conceptId, target } = resolution;
  const verb = operation.op === "delete" ? "Remove" : "Update";
  return writeAssets(
    target,
    {
      purpose: `${type}-${verb.toLowerCase()}`,
      message: `${verb} ${formatRefForMessage({ type, name, origin: target.source.name })}`,
    },
    (w) =>
      operation.op === "create"
        ? w.create(
            { type, name, content: operation.content, unlisted: operation.sensitive },
            { exclusive: operation.exclusive },
          )
        : operation.op === "update"
          ? w.update(conceptId, operation.content, { revision: operation.revision })
          : w.delete(conceptId, { revision: operation.revision }),
  );
}
