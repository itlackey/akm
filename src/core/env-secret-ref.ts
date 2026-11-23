// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What `env` and `secret` add to an asset: typed refs, the owner check a command makes on them, a secret's
 * value, and the write target of a mutation. Finding, listing and writing go through the asset facade
 * (`src/core/assets/`), so an env file or secret behaves the same whichever adapter holds it. The only value read
 * here is a secret's, for the callers that inject it ({@link readSecret}); no value is surfaced.
 */

import { resolveSourceEntries } from "../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "./asset/asset-create";
import { stashDirFor } from "./asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "./asset/asset-ref";
import { type AssetRef, conceptIdFromTypeName, displayRef } from "./asset/resolve-ref";
import { type Asset, findAsset, listAssets } from "./assets/read";
import { assetType } from "./assets/type";
import { readAsset, type WriteResult, writeAssets } from "./assets/write";
import { deriveBundleIds } from "./bundle-id";
import { scanEnvKeyNames } from "./common";
import { type AkmConfig, loadConfig } from "./config/config";
import { NotFoundError, UsageError } from "./errors";
import { resolveMutationTarget } from "./mutation-target";
import { formatRefForMessage, type ResolvedWriteTarget } from "./write-source";

/**
 * Every listed env asset with its key names (never values or comments), for `commands/health` as well as
 * `env list`. `config` defaults to the real `loadConfig()`.
 */
export function listEnvsRecursive(
  config: AkmConfig = loadConfig(),
): Array<{ ref: string; path?: string; keys: string[] }> {
  return listAssets({ sources: resolveSourceEntries(undefined, config), type: "env" }).map(
    ({ conceptId, bundle, entry }) => ({
      ref: makeEnvRef(conceptId, bundle, config),
      ...(entry.file !== undefined ? { path: entry.file } : {}),
      keys: scanEnvKeyNames(entry.content()),
    }),
  );
}

/** Every listed secret, by ref. Its value is not read. */
export function listSecrets(config: AkmConfig = loadConfig()): Array<{ ref: string; path?: string }> {
  return listAssets({ sources: resolveSourceEntries(undefined, config), type: "secret" }).map(
    ({ conceptId, bundle, entry }) => ({
      ref: makeSecretRef(conceptId, bundle),
      ...(entry.file !== undefined ? { path: entry.file } : {}),
    }),
  );
}

export function parseEnvRef(ref: string): AssetRef {
  return parseTypedRef(ref, "env", "env/<name>");
}

export function parseSecretRef(ref: string): AssetRef {
  return parseTypedRef(ref, "secret", "secrets/<name>");
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
 * The asset a read ref of the given type names. The ref is the asset's path inside its bundle, so it may sit
 * anywhere: what makes it an env or a secret is the asset, not the ref's first folder.
 */
function ownerOfType(ref: string, type: "env" | "secret", form: string): { conceptId: string; asset: Asset } {
  const parsed = parseBundleRef(ref);
  const asset = parsed.fragment === undefined ? resolveRefOwner(ref) : undefined;
  if (!asset) {
    // Not found: a typed placement address reads as "not found", anything else as the wrong kind of ref.
    parseTypedRef(ref, type, form);
    throw new NotFoundError(`${type === "env" ? "Env" : "Secret"} not found: ${ref}`);
  }
  if (assetType(asset) !== type) {
    throw new UsageError(
      `Expected ${type === "env" ? "an" : "a"} ${type} ref (${form} or <bundle>//${form}); got "${ref}". Write the full ref.`,
      "INVALID_FLAG_VALUE",
    );
  }
  // The concept id as the ref wrote it (`env/app.env`): commands echo a ref as it was written, not as akm keeps it.
  return { conceptId: parsed.conceptId, asset };
}

/** The asset any ref names right now (a sensitive env file or secret included), or undefined when no bundle holds it. The lookup behind `${ref}` tokens. */
export function resolveRefOwner(ref: string): Asset | undefined {
  return findAsset(ref, { sources: resolveSourceEntries(undefined, loadConfig()) });
}

/**
 * A secret's value: its content as its adapter reads it, with surrounding whitespace trimmed, so a hand-written
 * file's trailing newline never lands in an HTTP header. The one read every consumer uses.
 */
export function secretValueOf(asset: Asset): string {
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
 * `config` defaults to the real `loadConfig()`; `listEnvsRecursive` threads its own through so a caller-supplied
 * config governs ref display as it governs which bundles are listed.
 */
export function makeEnvRef(conceptId: string, bundleId?: string, config: AkmConfig = loadConfig()): string {
  // `env/name` in the primary bundle, `bundle//env/name` in another.
  return displayRef({ conceptId, bundleId }, displayDefaultBundle(bundleId, config));
}

export function makeSecretRef(conceptId: string, bundleId?: string): string {
  return displayRef({ conceptId, bundleId }, displayDefaultBundle(bundleId));
}

function displayDefaultBundle(bundleId?: string, config: AkmConfig = loadConfig()): string | undefined {
  if (config.defaultBundle || !bundleId) return config.defaultBundle;
  const primary = deriveBundleIds(resolveSourceEntries(undefined, config))[0];
  return primary === bundleId ? bundleId : undefined;
}

/** The env asset a ref names right now; `NotFoundError` when no bundle holds it (creating one goes through {@link resolveEnvWriteTarget}). */
export function resolveEnvPath(ref: string): { conceptId: string; asset: Asset } {
  return ownerOfType(ref, "env", "env/<name>");
}

/** The secret asset a ref names right now. Its content is the value: never print or log it. */
export function resolveSecretPath(ref: string): { conceptId: string; asset: Asset } {
  return ownerOfType(ref, "secret", "secrets/<name>");
}

/**
 * Read the secret `ref` names: its trimmed value, and the bundle that holds it.
 * Callers MUST NOT write the value to stdout or any log.
 */
export function readSecret(ref: string): { conceptId: string; bundle: string; value: string } {
  const { conceptId, asset } = ownerOfType(ref, "secret", "secrets/<name>");
  return { conceptId, bundle: asset.bundle, value: secretValueOf(asset) };
}

// ── Write-target resolution (env/secret mutations) ───────────────────────────
//
// A write goes through the target selection every other write command shares: an explicit `--bundle`, else
// `defaultWriteTarget`, else the working bundle, which must be writable.

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
  return readAsset(resolution.target.source, resolution.conceptId);
}

/**
 * Create, update or delete the env file or secret a resolution names, through the target bundle's adapter, as one
 * operation committed at the target's boundary. A removal deletes: an env file or secret is never retired.
 */
export function writeEnvSecret(
  resolution: EnvSecretWriteResolution,
  operation:
    | { op: "create"; content: string | Buffer; exclusive?: boolean }
    | { op: "update"; content: string | Buffer; revision?: string }
    | { op: "delete"; revision?: string },
): WriteResult {
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
        ? w.create({ type, name, content: operation.content }, { exclusive: operation.exclusive })
        : operation.op === "update"
          ? w.update(conceptId, operation.content, { revision: operation.revision })
          : w.delete(conceptId, { revision: operation.revision }),
  );
}
