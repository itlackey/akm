// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The migrator's one config step: `config.json` read in any shape 0.9.32 through
 * 0.10.261013-beta wrote, and written back in the current one. The CLI proper reads
 * only the current shape; the retired `engines` form, `secret://` references, the
 * `models.json` overlay and a key held in config are converted here and nowhere else.
 */

import { isDeepStrictEqual } from "node:util";
import { getConfigPath } from "../../../src/core/paths";
import { isRefToken } from "../../../src/core/ref-token";
import { isRecord } from "../../../src/core/common";
import {
  type AkmConfig,
  buildEffectiveConfig,
  dropInvalidImproveBase,
  readConfigFile,
  resetConfigCache,
  resolveSecret,
  type SecretStoreResolver,
  unknownConfigKeyPaths,
  validateCompleteConfig,
} from "../../../src/core/config/config";
import {
  backupExistingConfig,
  parseConfigText,
  readConfigText,
  withConfigLock,
  writeConfigAtomic,
} from "../../../src/core/config/config-io";
import { CURRENT_CONFIG_VERSION } from "../../../src/core/config/config-schema";
import { fileFlatCredentials, writeCredential } from "../../../src/core/config/credentials";
import { isPlainObject } from "../../../src/core/config/deep-merge";
import { findUnusableEntries } from "../../../src/core/config/unusable-entries";
import { convertEngineConfig, type EngineTarget } from "./convert-engines";
import { documentEndpoint, planKeyMoves } from "./migrate-keys";
import { modelsFileExists, readModelsFile, retireModelsFile } from "./models-file";
import { type EngineTargets, rememberEngineTargets, rememberedEngineTargets } from "./retired-engines";

/** The file as it says it: parsed, with the retired `secret://` forms and `configVersion` read, and nothing else converted. */
function readConfigDocument(text: string, sourcePath?: string): Record<string, unknown> {
  return liftRetiredSecretRefs(readConfigFile(text, sourcePath)) as Record<string, unknown>;
}

/**
 * The connections and harnesses an `extends` base defines on its own, as the
 * loader reads them: what the migrator folds into
 * entries only the base defines, as partial local entries, once the file is gone.
 */
function inheritedEntries(
  document: Record<string, unknown>,
  configPath: string,
): { connections: Record<string, unknown>; harnesses: Record<string, unknown> } | undefined {
  if (document.extends === undefined) return undefined;
  const base = buildEffectiveConfig({ configVersion: document.configVersion, extends: document.extends }, configPath);
  return { connections: { ...base.connections }, harnesses: { ...base.harnesses } };
}

/**
 * What each old engine name now is, so an `engine:` selector (a flag, or a key in an asset or a task source)
 * keeps meaning the service it always named: the conversion renames the engine `defaults` named to `default`
 * and moves an old `default` aside. While the file is still in the `engines` form the answer is the
 * conversion's own; after `akm migrate apply` has rewritten it, the names the migrator remembered, until
 * every reference it can rewrite is rewritten. Resolution and the migrator both ask here.
 */
export function retiredEngineTargets(): EngineTargets {
  const configPath = getConfigPath();
  const text = readConfigText(configPath);
  if (text === undefined) return {};
  const live = convertEngineConfig(readConfigDocument(text, configPath), {
    modelsOverlay: readModelsFile(),
    env: process.env,
  }).targets;
  return Object.keys(live).length > 0 ? live : rememberedEngineTargets();
}

/** The retired `secret://<name>` credential form; it survives only in {@link liftRetiredSecretRefs}. */
const SECRET_STORE_REFERENCE_PATTERN = /^secret:\/\/(.+)$/;

/**
 * The `${ref}` a retired `secret://<x>` value reads as: `${<x>}` when `<x>` is
 * already a full ref, else `${secrets/<x>}`. `undefined` for any other string.
 * Shared by the config reader and the frozen workflow runner decoder.
 */
function liftRetiredSecretRef(value: string): string | undefined {
  const name = SECRET_STORE_REFERENCE_PATTERN.exec(value)?.[1];
  if (name === undefined) return undefined;
  return isRefToken(`\${${name}}`) ? `\${${name}}` : `\${secrets/${name}}`;
}

/**
 * `secret://<x>` is retired in favour of `${ref}`. A value in that form becomes its {@link liftRetiredSecretRef},
 * so `akm migrate apply`'s `configFile` step persists the new form. (The runtime names each one, once, as it reads the file.)
 */
function liftRetiredSecretRefs(node: unknown): unknown {
  if (typeof node === "string") return liftRetiredSecretRef(node) ?? node;
  if (Array.isArray(node)) return node.map(liftRetiredSecretRefs);
  if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, liftRetiredSecretRefs(child)]));
  return node;
}

/**
 * Reduce `after` (the effective config with the change applied) to what the file
 * should hold: what changed relative to `before`, plus whatever `localRaw` (the
 * local file's own content, before the `extends` merge) already had. What only
 * came along from `extends` or a default is left out, so it keeps being read from
 * the base instead of being frozen as a local literal.
 */
function pruneUnchangedInheritedFields(before: unknown, after: unknown, localRaw: unknown): unknown {
  if (!isPlainObject(after) || !isPlainObject(before)) return after;
  const localRecord = isPlainObject(localRaw) ? localRaw : undefined;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const afterValue = after[key];
    const beforeValue = before[key];
    const localHasKey = localRecord ? Object.hasOwn(localRecord, key) : false;
    if (isPlainObject(afterValue) && isPlainObject(beforeValue)) {
      const pruned = pruneUnchangedInheritedFields(
        beforeValue,
        afterValue,
        localHasKey ? localRecord?.[key] : undefined,
      );
      const prunedHasContent = isPlainObject(pruned) ? Object.keys(pruned).length > 0 : pruned !== undefined;
      if (prunedHasContent || localHasKey) result[key] = pruned;
      continue;
    }
    if (localHasKey || !isDeepStrictEqual(afterValue, beforeValue)) {
      result[key] = afterValue;
    }
  }
  return result;
}



/**
 * What `akm migrate apply` persists: the file read as the current shape
 * (the retired `engines` form converted, the schema's own normalizations), only
 * the changed-or-already-local fields.
 */
function configWriteBody(
  localRaw: Record<string, unknown> | undefined,
  current: AkmConfig,
  next: AkmConfig,
  persistTopLevelKeys: readonly (keyof AkmConfig)[] = [],
): AkmConfig {
  // A first write keeps the established full-default scaffold. Besides being
  // useful to a new user, the add -> rejected-install -> remove lifecycle
  // relies on that symmetry to return a pristine install to DEFAULT_CONFIG.
  if (localRaw === undefined) return next;

  const pruned = pruneUnchangedInheritedFields(current, next, localRaw) as Record<string, unknown>;
  // A caller may need to persist an explicit user choice even when it equals
  // the schema default. Interactive setup uses this for semanticSearchMode:
  // "off" means the user declined the opt-in, not an incidental default that
  // should disappear from the saved configuration.
  for (const key of persistTopLevelKeys) {
    if (Object.hasOwn(next, key)) pruned[key] = next[key];
  }
  pruned.configVersion = CURRENT_CONFIG_VERSION;

  // Keep existing top-level keys in their authored order. Lifecycle rollback
  // writes the same logical object twice (add, then remove); reordering those
  // surviving keys would violate its byte-parity guarantee even though the
  // parsed JSON is equivalent. Newly changed keys follow in `next` order,
  // while nested maps (notably `bundles`) retain mutation-selected ordering.
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(localRaw)) {
    if (Object.hasOwn(pruned, key)) ordered[key] = pruned[key];
  }
  for (const [key, value] of Object.entries(pruned)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  }
  return ordered as AkmConfig;
}


function deleteConfigPath(node: Record<string, unknown>, keyPath: readonly string[]): void {
  let cursor: unknown = node;
  for (const segment of keyPath.slice(0, -1)) {
    if (!isRecord(cursor) && !Array.isArray(cursor)) return;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (isRecord(cursor)) delete cursor[keyPath[keyPath.length - 1] as string];
}


export interface ConfigFileNormalization {
  /** Top-level keys whose stored shape differs from the current one. */
  readonly keys: readonly string[];
  readonly changed: boolean;
  readonly applied: boolean;
  readonly backupPath?: string;
  /** The `credentials.json` entries the config's keys move to (names only), when any do. */
  readonly credentials?: readonly string[];
  /** Where `credentials.json` was copied to before its older entries were filed, when any were. */
  readonly credentialsBackupPath?: string;
  /** Where the retired `models.json` was moved to, after its aliases were folded in. */
  readonly modelsFileBackupPath?: string;
  /** What each engine of the retired `engines` form became, for the step that rewrites assets' `engine:` keys. */
  readonly engineTargets?: Readonly<Record<string, EngineTarget>>;
  /** What the conversion could not carry, and each key and entry the step left alone or moved. */
  readonly notes?: readonly string[];
}

/** What `akm migrate apply` needs from outside the config module to read a key the config holds as a secret reference. */
export interface NormalizeConfigOptions {
  readonly apply: boolean;
  readonly resolveFromStore?: SecretStoreResolver;
}

/**
 * A connection or harness the reader drops stays in the file exactly as written,
 * with a note on what to fix. One this file only half says, which an `extends`
 * base completes, is not dropped (it is in `current`) and gets no note.
 */
function keepUnusableEntries(
  body: Record<string, unknown>,
  localRaw: Record<string, unknown>,
  current: AkmConfig,
  notes: string[],
): void {
  for (const { kind, name, why } of findUnusableEntries(localRaw)) {
    const holder = kind === "connection" ? "connections" : "harnesses";
    if (Object.hasOwn(current[holder] ?? {}, name)) continue;
    const entries = isRecord(body[holder]) ? (body[holder] as Record<string, unknown>) : {};
    body[holder] = { ...entries, [name]: (localRaw[holder] as Record<string, unknown>)[name] };
    notes.push(`${holder}.${name}: kept as written, and ignored by akm because ${why}. Fix it, or remove it.`);
  }
}

/**
 * The migrator's one config step. The reader tolerates the `{kind, ref, sourceId}`
 * scheduler entries 0.9.x writes and drops unknown keys; this writes the current shape back to `config.json` so the tolerance becomes
 * durable: the retired `engines` form converted to `connections` / `harnesses`,
 * every key akm no longer reads from config filed in `credentials.json`
 * ({@link planKeyMoves}), and a connection or harness the reader drops kept as
 * written. Reports without writing unless `apply` is set.
 */
export function normalizeConfigFile(configPath: string, options: NormalizeConfigOptions): ConfigFileNormalization {
  return withConfigLock(() => {
    const text = readConfigText(configPath);
    if (text === undefined) return { keys: [], changed: false, applied: false };
    const raw = parseConfigText(text, configPath);
    const document = readConfigDocument(text, configPath);
    // The conversion runs before the unknown-key sweep below deletes what the
    // schema does not know (inventory surprise 8).
    const overlay = readModelsFile();
    const inherited = overlay === undefined ? undefined : inheritedEntries(document, configPath);
    const converted = convertEngineConfig(document, {
      modelsOverlay: overlay,
      env: process.env,
      ...(inherited ? { inherited } : {}),
    });
    const plan = planKeyMoves(document, converted, {
      resolveSecretRef: (ref) => resolveSecret(ref, options.resolveFromStore),
    });
    const localRaw = plan.config;
    const current = buildEffectiveConfig(localRaw, configPath);
    const next = validateCompleteConfig({ ...current, configVersion: CURRENT_CONFIG_VERSION });
    const body = configWriteBody(localRaw, current, next) as Record<string, unknown>;
    // The reader resolves each bundle `path` and drops an unplaceable one; the file keeps what was written.
    if (isPlainObject(localRaw.bundles)) body.bundles = localRaw.bundles;
    for (const keyPath of unknownConfigKeyPaths(body)) deleteConfigPath(body, keyPath);
    // A model-base value the reader ignores is dropped here, as every other retired value is.
    if (isRecord(body.improve)) body.improve = dropInvalidImproveBase(body, configPath).improve;
    // `improve.strategies["graph-refresh"]` is schema-valid (any name is a
    // legal custom-strategy key), so it never reaches the unknown-key sweep
    // above. It can only be a leftover override of the deleted graph-refresh
    // built-in (0.9.17-alpha.9) — resolveImproveStrategy now refuses that
    // name unconditionally, so the override can never apply again. Drop it
    // the same way any other retired key is dropped: only by `akm migrate
    // apply`, never by an ordinary write.
    const strategies = (body.improve as Record<string, unknown> | undefined)?.strategies as
      | Record<string, unknown>
      | undefined;
    if (strategies && Object.hasOwn(strategies, "graph-refresh")) delete strategies["graph-refresh"];
    // A key in the older flat form is filed only under an endpoint this file itself gives the block.
    const flat = fileFlatCredentials((slot) => documentEndpoint(plan.config, slot), false, plan.moves);
    const notes = [...converted.notes, ...plan.notes, ...flat.notes];
    const retiredTarget = localRaw.defaultWriteTarget;
    if (typeof retiredTarget === "string" && retiredTarget !== localRaw.defaultBundle) {
      notes.push(
        `defaultWriteTarget "${retiredTarget}" is dropped. It named a different bundle from defaultBundle ${JSON.stringify(localRaw.defaultBundle ?? null)}; writes now go to defaultBundle.`,
      );
    }
    keepUnusableEntries(body, localRaw, current, notes);
    const hasModelsFile = modelsFileExists();
    if (hasModelsFile) {
      notes.push(
        "models.json: its aliases are folded in where they name a configured connection or harness (the ones that do not are listed above), then the file moves to the config-backups directory.",
      );
    }
    const keys = [...new Set([...Object.keys(raw), ...Object.keys(body)])]
      .filter((key) => JSON.stringify(raw[key]) !== JSON.stringify(body[key]))
      .sort();
    const reported = {
      keys,
      ...(plan.moves.length > 0 || flat.filed.length > 0
        ? { credentials: [...plan.moves.map((move) => move.name), ...flat.filed] }
        : {}),
      ...(notes.length > 0 ? { notes } : {}),
      ...(Object.keys(converted.targets).length > 0 ? { engineTargets: converted.targets } : {}),
    };
    const changed = keys.length > 0 || hasModelsFile || flat.filed.length > 0;
    if (!changed || !options.apply) return { ...reported, changed, applied: false };
    let backup: ReturnType<typeof backupExistingConfig>;
    const credentialsBackupPath =
      flat.filed.length > 0
        ? fileFlatCredentials((slot) => documentEndpoint(plan.config, slot), true, plan.moves).backupPath
        : undefined;
    if (keys.length > 0) {
      // The keys are filed before the file that holds them is rewritten; a store
      // that cannot take them (malformed, unwritable) throws here and loses none.
      for (const move of plan.moves) writeCredential(move.slot, move.value, move.endpoint);
      // The old engine names outlive the file that had them, until the references to them are migrated.
      if (Object.keys(converted.targets).length > 0) rememberEngineTargets(converted.targets);
      backup = backupExistingConfig(configPath);
      writeConfigAtomic(configPath, body);
      resetConfigCache();
    }
    const modelsFileBackupPath = hasModelsFile ? retireModelsFile() : undefined;
    return {
      ...reported,
      changed: true,
      applied: true,
      ...(backup ? { backupPath: backup.timestamped } : {}),
      ...(credentialsBackupPath ? { credentialsBackupPath } : {}),
      ...(modelsFileBackupPath ? { modelsFileBackupPath } : {}),
    };
  });
}

