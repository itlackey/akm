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

import fs from "node:fs";
import path from "node:path";
import { type ConceptOwnerMatch, resolveConceptOwner } from "../indexer/lookup/adapter-concept-owner";
import { type SearchSource as IndexSearchSource, resolveSourceEntries } from "../indexer/search/search-source";
import { buildFileContext } from "../indexer/walk/file-context";
import { declaredTypeForPath } from "../indexer/walk/matchers";
import { isFileOrFileSymlink } from "../indexer/walk/walker";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "./asset/asset-create";
import { assetPathForName, refForFile, stashDirFor } from "./asset/asset-placement";
import { makeBundleRef, parseBundleRef } from "./asset/asset-ref";
import type { AssetRef } from "./asset/resolve-ref";
import { conceptIdFromTypeName, displayRef } from "./asset/resolve-ref";
import { isWithin } from "./common";
import { type AkmConfig, loadConfig } from "./config/config";
import { NotFoundError, UsageError } from "./errors";
import { resolveMutationTarget } from "./mutation-target";
import { sensitiveMarkerPath } from "./sensitive-marker-path";
import { formatRefForMessage, type ResolvedWriteTarget, withWriteTargetMutation } from "./write-source";

export { sensitiveMarkerPath } from "./sensitive-marker-path";
export type { IndexSearchSource };

/**
 * Walk each stash's env files and return one entry per `.env` file, using the
 * env asset spec's canonical-name logic (e.g. `env/team/prod.env` →
 * `env/team/prod`, `env/team/.env` → `env/team/default`). Moved here from
 * `commands/env/env-cli.ts` (#950) so `commands/health` can reuse it to name
 * which env asset supplies a credential's variable — pure move, `akm env
 * list`'s behaviour is unchanged. `listKeysFn` stays injected (rather than a
 * static import of `commands/env/env.ts`) so this core module never depends
 * upward on the commands layer. `config` defaults to the real `loadConfig()`
 * (unchanged default for `akm env list`); `commands/health` passes its own
 * injected/resolved config so a test-supplied `loadConfig` seam is honoured
 * instead of this always re-reading the real config/sources.
 */
export function listEnvsRecursive(
  listKeysFn: (envPath: string) => { keys: string[] },
  config: AkmConfig = loadConfig(),
): Array<{ ref: string; path: string; keys: string[] }> {
  const result: Array<{ ref: string; path: string; keys: string[] }> = [];
  for (const source of resolveSourceEntries(undefined, config)) {
    const root = path.join(source.path, "env");
    if (!fs.existsSync(root)) continue;

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() && !(entry.isSymbolicLink() && isFileOrFileSymlink(full))) continue;
        if (entry.name !== ".env" && !entry.name.endsWith(".env")) continue;
        const conceptId = refForFile("env", source.path, full);
        if (!conceptId) continue;
        // Skip sensitive envs: a sibling .sensitive marker file suppresses listing.
        const markerPath = sensitiveMarkerPath(full, "env");
        if (fs.existsSync(markerPath)) continue;
        const { keys } = listKeysFn(full);
        result.push({ ref: makeEnvRef(conceptId, source, config), path: full, keys });
      }
    };
    walk(root);
  }
  return result;
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
 * The type of the asset a match owns, from where its file sits (the indexer's
 * directory rules, path only): sensitive files have no index row to ask, and the
 * owner walk must stay index-free.
 */
function ownedType(match: ConceptOwnerMatch): string | undefined {
  return declaredTypeForPath(buildFileContext(match.source.path, match.owner.path));
}

/**
 * The owner of a read ref of the given type. The ref is the file's path inside
 * its bundle, so it may sit anywhere: what makes it an env or a secret is the
 * owning file, not the ref's first folder.
 */
function ownerOfType(
  ref: string,
  type: "env" | "secret",
  form: string,
): { match: ConceptOwnerMatch; conceptId: string } {
  const parsed = parseBundleRef(ref);
  const match = parsed.fragment === undefined ? findEnvSecretOwner(parsed.bundle, parsed.conceptId) : undefined;
  if (!match) {
    // Not owned: a typed placement address reads as "not found", anything else as the wrong kind of ref.
    parseTypedRef(ref, type, form);
    throw new NotFoundError(`${type === "env" ? "Env" : "Secret"} not found: ${ref}`);
  }
  if (ownedType(match) !== type) {
    throw new UsageError(
      `Expected ${type === "env" ? "an" : "a"} ${type} ref (${form} or <bundle>//${form}); got "${ref}". Write the full ref.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return { match, conceptId: match.owner.conceptId };
}

/** The bundle and file that own an env or secret ref right now, or undefined. Sensitive files resolve too. */
function findEnvSecretOwner(origin: string | undefined, conceptId: string): ConceptOwnerMatch | undefined {
  return resolveConceptOwner({ bundle: origin, conceptId }, resolveSourceEntries(undefined, loadConfig()), {
    includeSensitive: true,
  });
}

/**
 * The file that owns any asset ref right now (the asset type its conceptId
 * names, and the bundle-qualified spelling of the ref), or undefined when no
 * bundle owns it. The lookup behind `${ref}` tokens.
 */
export function resolveRefOwner(ref: string): { absPath: string; type: string | undefined; ref: string } | undefined {
  const { bundle, conceptId } = parseBundleRef(ref);
  const match = findEnvSecretOwner(bundle, conceptId);
  return (
    match && {
      absPath: match.owner.path,
      type: ownedType(match),
      ref: makeBundleRef(match.bundleId, conceptId),
    }
  );
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
  absPath: string;
  source: IndexSearchSource;
  /** The bundle that owns the env file. */
  bundleId: string;
  dir: "env";
} {
  const { match, conceptId } = ownerOfType(ref, "env", "env/<name>");
  return { conceptId, absPath: match.owner.path, source: match.source, bundleId: match.bundleId, dir: "env" };
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
  absPath: string;
  source: IndexSearchSource;
} {
  const { match, conceptId } = ownerOfType(ref, "secret", "secrets/<name>");
  return { conceptId, absPath: match.owner.path, source: match.source };
}

// ── Write-target resolution (env/secret mutations) ───────────────────────────
//
// READS (`env run`/`show`/`path`, `secret run`) ask the one ref-to-file walk
// (`resolveConceptOwner`) above. (`secret path` used this same read-side
// resolver too, until it was REMOVED from the CLI in 0.9.0 — R-027 / D-49 — with
// `secret remove`, which resolved through the WRITE-target path below, so the two
// could silently name different files for the same ref. `secret remove` is back
// in 0.10, shaped like `env remove`: write-target resolution only.) WRITES route
// through the canonical `resolveWriteTarget` selection every other write command
// (remember/import/tasks/knowledge) shares: explicit `--bundle` wins, else
// the working stash, and the chosen source must be writable (a non-writable
// target fails fast with the shared typed ConfigError). Env/secret VALUES are still never read or surfaced
// here — these helpers only resolve the write target and the absolute path.

export interface EnvWriteResolution {
  name: string;
  absPath: string;
  target: ResolvedWriteTarget;
  parsedRef: AssetRef;
  ref: string;
}

/**
 * Resolve the destination for an env mutation. Mirrors {@link resolveEnvPath}
 * but selects the source via {@link resolveWriteTarget} (writability-checked)
 * instead of the read-side {@link resolveEnvPath}. `create` enforces a flat ref
 * name and applies `--path` as the subdirectory (matching `env create`).
 */
export function resolveEnvWriteTarget(
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): EnvWriteResolution {
  const parsed = parseEnvRef(ref);
  if (create) {
    assertFlatAssetName(parsed.name);
    parsed.name = combineCreatePath(normalizeCreateSubPath(create.subPath), parsed.name);
  }
  const resolved = resolveMutationTarget(loadConfig(), parsed, writeTarget, { allowedAdapters: ["akm", "dotenv"] });
  const { target } = resolved;
  const envRoot = path.join(target.source.path, "env");
  const absPath = assetPathForName("env", envRoot, parsed.name);
  if (!isWithin(absPath, envRoot)) {
    throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
  }
  return { name: parsed.name, absPath, target, parsedRef: resolved.ref, ref: resolved.displayRef };
}

export interface SecretWriteResolution {
  name: string;
  absPath: string;
  target: ResolvedWriteTarget;
  ref: string;
}

/**
 * Resolve the destination for a secret mutation. Mirrors
 * {@link resolveSecretPath} but selects the source via
 * {@link resolveWriteTarget} (writability-checked) instead of the read-side
 * {@link resolveSecretPath}.
 */
export function resolveSecretWriteTarget(
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): SecretWriteResolution {
  const parsed = parseSecretRef(ref);
  if (create) {
    assertFlatAssetName(parsed.name);
    parsed.name = combineCreatePath(normalizeCreateSubPath(create.subPath), parsed.name);
  }
  const resolved = resolveMutationTarget(loadConfig(), parsed, writeTarget, { allowedAdapters: ["akm", "dotenv"] });
  const { target } = resolved;
  const typeRoot = path.join(target.source.path, "secrets");
  const absPath = assetPathForName("secret", typeRoot, parsed.name);
  if (!isWithin(absPath, typeRoot)) {
    throw new UsageError(`Secret name "${parsed.name}" escapes the secrets directory.`);
  }
  return { name: parsed.name, absPath, target, ref: resolved.displayRef };
}

/**
 * Land an env/secret mutation on its write target's git boundary. Mirrors the
 * tasks/knowledge write path: record each mutated path, then fire the single
 * batch-at-boundary commit. Both steps are no-ops for filesystem targets (the
 * primary stash included) and for `env/` paths a stash `.gitignore` excludes, so
 * callers invoke it unconditionally after every create/ingest/set/remove.
 */
export function withEnvSecretWrite<T>(
  target: ResolvedWriteTarget,
  ref: { type: "env" | "secret"; name: string },
  op: "Update" | "Remove",
  paths: string[],
  mutate: () => T,
): T {
  return withWriteTargetMutation(
    target,
    paths,
    {
      purpose: `${ref.type}-${op.toLowerCase()}`,
      message: `${op} ${formatRefForMessage({ type: ref.type, name: ref.name, origin: target.source.name })}`,
    },
    mutate,
  );
}
