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
import { type SearchSource as IndexSearchSource, resolveSourceEntries } from "../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "./asset/asset-create";
import { assetPathForName, deriveCanonicalAssetName } from "./asset/asset-placement";
import type { AssetRef } from "./asset/resolve-ref";
import { displayRef, isFullRefInput, parseRefInput } from "./asset/resolve-ref";
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
        if (!entry.isFile()) continue;
        if (entry.name !== ".env" && !entry.name.endsWith(".env")) continue;
        const canonical = deriveCanonicalAssetName("env", root, full);
        if (!canonical) continue;
        // Skip sensitive envs: a sibling .sensitive marker file suppresses listing.
        const markerPath = sensitiveMarkerPath(full, "env");
        if (fs.existsSync(markerPath)) continue;
        const { keys } = listKeysFn(full);
        result.push({ ref: makeEnvRef(canonical, source, config), path: full, keys });
      }
    };
    walk(root);
  }
  return result;
}

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
      "The `vault` asset type was removed in 0.9.0 — use `env/` (whole .env config) or `secrets/` (a single value).",
      "INVALID_FLAG_VALUE",
    );
  }
}

/**
 * Q-08 ruling: the pre-0.9.0 `type:name` ref grammar taught `env:<name>` /
 * `secret:<name>` (help text and docs also implied `environment:`/`secrets:`
 * variants) as the way to address a single env/secret. That grammar is GONE —
 * NO alias, no re-acceptance (same rule as the retired `vault:` prefix above).
 * Left unchecked, a colon-prefixed ref does not error here at all: it falls
 * through to the "bare name" convenience below and gets silently qualified
 * into a literal `env/env:name` (or `secrets/secret:name`) file that can never
 * exist — a confusing not-found that hides the real mistake instead of naming
 * it. Reject it here, loudly, before that happens.
 */
function assertNotColonRef(ref: string, aliases: readonly string[], replacement: "env/" | "secrets/"): void {
  const boundary = ref.indexOf("//");
  const bare = (boundary >= 0 ? ref.slice(boundary + 2) : ref).trim();
  const colon = bare.indexOf(":");
  if (colon <= 0) return;
  const head = bare.slice(0, colon).toLowerCase();
  if (!aliases.includes(head)) return;
  const name = bare.slice(colon + 1);
  throw new UsageError(
    `The \`${head}:\` ref spelling was removed in 0.9.0 — use the slash form instead: \`${replacement}${name}\`.`,
    "INVALID_FLAG_VALUE",
  );
}

export function parseEnvRef(ref: string): AssetRef {
  // Accept a bare env name (`prod`, `sub/prod`) or the new-grammar
  // `[bundle//]env/name` conceptId. A bare name's leading segment maps to no
  // asset type, so it is qualified with the `env/` conceptId prefix; anything
  // already a full new-grammar ref is parsed as-is.
  assertNotRemovedVaultRef(ref);
  assertNotColonRef(ref, ["env", "environment"], "env/");
  return parseRefInput(isFullRefInput(ref) ? ref : `env/${ref}`);
}

export function findEnvSource(origin: string | undefined, type: "env" | "secret", name: string): IndexSearchSource {
  const sources = resolveSourceEntries(undefined, loadConfig());
  if (sources.length === 0) {
    throw new UsageError("No bundles configured. Run `akm bundle create` to create your working bundle.");
  }
  const candidates = origin ? resolveSourcesForOrigin(origin, sources) : sources;
  const typeDir = type === "env" ? "env" : "secrets";
  const member = candidates.find((source) =>
    fs.existsSync(assetPathForName(type, path.join(source.path, typeDir), name)),
  );
  if (member) return member;
  if (!origin) {
    const fallback = candidates[0];
    if (fallback) return fallback;
    throw new UsageError("No bundles configured. Run `akm bundle create` to create your working bundle.");
  }
  const named = candidates[0];
  if (!named) {
    throw new NotFoundError(`Source not found for origin: ${origin}`);
  }
  return named;
}

/**
 * `config` defaults to the real `loadConfig()`, same as {@link displayDefaultBundle}.
 * `listEnvsRecursive` threads its own (possibly injected) config through here so a
 * caller-supplied config governs ref display the same way it governs which stashes
 * get walked — otherwise this would silently fall back to reading the real config a
 * second time even when the walk itself honoured an injected one.
 */
export function makeEnvRef(name: string, source?: IndexSearchSource, config: AkmConfig = loadConfig()): string {
  // F4b output-spelling flip: `env/name` in the primary stash, `bundle//env/name`
  // for a slug-clean named source.
  return displayRef({ type: "env", name, bundleId: source?.registryId }, displayDefaultBundle(source, config));
}

/**
 * Resolve an env ref to an absolute `.env` path. Accepts the `env/<name>`
 * conceptId (or a bare name, auto-qualified into it) — the retired
 * `env:`/`environment:` colon spelling is rejected loudly (Q-08), never
 * silently resolved. The path is returned even when the file does not yet
 * exist (so `create` writes under `env/`).
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
    throw new UsageError(`Expected an env ref (env/<name>); got "${ref}".`);
  }
  const source = findEnvSource(parsed.origin, "env", parsed.name);

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
  assertNotColonRef(ref, ["secret", "secrets"], "secrets/");
  return parseRefInput(isFullRefInput(ref) ? ref : `secrets/${ref}`);
}

export function makeSecretRef(name: string, source?: IndexSearchSource): string {
  // F4b output-spelling flip: `secrets/name` in the primary stash,
  // `bundle//secrets/name` for a slug-clean named source.
  return displayRef({ type: "secret", name, bundleId: source?.registryId }, displayDefaultBundle(source));
}

function displayDefaultBundle(source?: IndexSearchSource, config: AkmConfig = loadConfig()): string | undefined {
  if (config.defaultBundle || !source) return config.defaultBundle;
  const primary = resolveSourceEntries(undefined, config)[0];
  return primary && path.resolve(primary.path) === path.resolve(source.path) ? source.registryId : undefined;
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
    throw new UsageError(`Expected a secret ref (secrets/<name>); got "${ref}".`);
  }
  if (create) {
    assertFlatAssetName(parsed.name);
    parsed.name = combineCreatePath(normalizeCreateSubPath(create.subPath), parsed.name);
  }
  // Source resolution is identical for every asset type; reuse the env helper.
  const source = findEnvSource(parsed.origin, "secret", parsed.name);
  const typeRoot = path.join(source.path, "secrets");
  const absPath = assetPathForName("secret", typeRoot, parsed.name);
  // Defense-in-depth: ensure the resolved path stays inside the secrets dir.
  if (!isWithin(absPath, typeRoot)) {
    throw new UsageError(`Secret name "${parsed.name}" escapes the secrets directory.`);
  }
  return { name: parsed.name, absPath, source };
}

// ── Write-target resolution (env/secret mutations) ───────────────────────────
//
// READS (`env run`/`show`/`list`/`path`, `secret run`/`list`) keep the
// origin-aware, all-sources `findEnvSource` resolution above. (`secret path`
// used this same read-side resolver too, until it was REMOVED from the CLI in
// 0.9.0 alongside `secret remove` — R-027 / D-49 — because `remove` resolved
// through the WRITE-target path below instead, so the two spellings could
// silently name different files for the same ref; `resolveSecretPath` below
// still exists and is still exercised by `secret run`.) WRITES route
// through the canonical `resolveWriteTarget` selection every other write command
// (remember/import/tasks/knowledge) shares: explicit `--target` wins, else
// `defaultWriteTarget`, else the working stash, and the chosen source must be
// writable (a non-writable `--target`/`defaultWriteTarget` fails fast with the
// shared typed ConfigError). Env/secret VALUES are still never read or surfaced
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
 * instead of the read-side {@link findEnvSource}. `create` enforces a flat ref
 * name and applies `--path` as the subdirectory (matching `env create`).
 */
export function resolveEnvWriteTarget(
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): EnvWriteResolution {
  const parsed = parseEnvRef(ref);
  if (parsed.type !== "env") {
    throw new UsageError(`Expected an env ref (env/<name>); got "${ref}".`);
  }
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
 * {@link findEnvSource}.
 */
export function resolveSecretWriteTarget(
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): SecretWriteResolution {
  const parsed = parseSecretRef(ref);
  if (parsed.type !== "secret") {
    throw new UsageError(`Expected a secret ref (secrets/<name>); got "${ref}".`);
  }
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
      ignored: "local-only",
      purpose: `${ref.type}-${op.toLowerCase()}`,
      message: `${op} ${formatRefForMessage({ type: ref.type, name: ref.name, origin: target.source.name })}`,
    },
    mutate,
  );
}
