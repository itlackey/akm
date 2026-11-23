// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A task is an asset, named by its ref. A bare task id is CLI sugar for it, resolved here and nowhere else: through
 * the bundle's task assets, by concept id as written, else by name (the concept id without the task type's folder).
 * No caller computes where an adapter keeps its tasks. This is the one function the ref qualifier replaces.
 */

import { stashDirFor, withoutTypeHead } from "../core/asset/asset-placement";
import { makeBundleRef } from "../core/asset/asset-ref";
import { conceptIdFromTypeName } from "../core/asset/resolve-ref";
import { adapterDeclares, adapterWrites, bundleAdapterId } from "../core/assets/gate";
import { type Asset, listAssets, readFrom, requireAsset } from "../core/assets/read";
import { assetTypes } from "../core/assets/type";
import { addressOf } from "../core/assets/write";
import { NotFoundError, UsageError } from "../core/errors";
import type { SearchSource } from "../indexer/search/search-source";

/** Where tasks are looked up: an explicit source, else the configured bundle with this id. */
export type TaskScope = { sources: readonly SearchSource[] } | { bundle: string };

/** A task bundle as the commands hold it. */
export interface TaskBundleSource {
  name: string;
  path: string;
  adapterId?: string;
  location?: string;
}

/** The scope of one source, under the id its refs use. */
export function taskScopeOf(source: TaskBundleSource): { sources: readonly SearchSource[] } {
  return {
    sources: [
      {
        path: source.path,
        registryId: source.name,
        ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
        ...(source.location !== undefined ? { location: source.location } : {}),
      },
    ],
  };
}

/** The file that holds a task, for messages and for the parser to name; the ref of a task no file holds. */
export function taskFileOf(asset: Asset): string {
  // asset-io: display
  return asset.entry.file ?? asset.ref;
}

/** The asset `ref` names in the bundle held at `source`; a `NotFoundError` when it holds none. */
export function requireAssetIn(source: TaskBundleSource, ref: string): Asset {
  return requireAsset(ref, { sources: taskScopeOf(source).sources });
}

/** The task assets of `candidates` (a listing made without a type), typed by the index. */
export function taskAssetsAmong(candidates: readonly Asset[]): Asset[] {
  const types = assetTypes(candidates);
  return candidates.filter((asset) => types.get(asset) === "task");
}

/**
 * What the bundle's adapter puts before a task's name in its concept id (`tasks/`, or nothing): where it places a task
 * named so, when it writes tasks. Asked of the adapter, never assumed from its id.
 */
function taskPrefixIn(source: TaskBundleSource): string {
  // An adapter that does not write tasks places none: a task there is named by its concept id.
  if (!adapterWrites(source, "task")) return "";
  const probe = "task-name-probe";
  const placed = addressOf(source, conceptIdFromTypeName("task", probe)).conceptId;
  return placed.endsWith(probe) ? placed.slice(0, placed.length - probe.length) : "";
}

/**
 * A task's id: its name in the bundle, which is what a scheduler row, a log and a history row call it. The concept id
 * without the prefix the bundle's adapter places tasks under.
 */
export function taskIdOf(asset: Asset, source: TaskBundleSource): string {
  const prefix = taskPrefixIn(source);
  return prefix !== "" && asset.conceptId.startsWith(prefix) ? asset.conceptId.slice(prefix.length) : asset.conceptId;
}

/** The concept ids `input` can name: as written, or under the prefix tasks are placed under. */
function spellingsOf(scope: TaskScope, input: string): string[] {
  const source = "sources" in scope ? scope.sources[0] : undefined;
  // A bundle named only by its id has no adapter to ask: the task type's own folder.
  const folder = stashDirFor("task");
  const prefix =
    source?.registryId !== undefined
      ? taskPrefixIn({
          name: source.registryId,
          path: source.path,
          ...(source.adapterId ? { adapterId: source.adapterId } : {}),
        })
      : folder !== undefined
        ? `${folder}/`
        : "";
  return [...new Set([input, `${prefix}${input}`])];
}

/** The task `input` names in a scope; undefined when no task of the scope has that id. */
export function findTask(scope: TaskScope, input: string): Asset | undefined {
  const spellings = spellingsOf(scope, input);
  // Only the assets the input can name are typed, not the whole bundle.
  const named = taskAssetsAmong(listAssets(scope).filter((asset) => spellings.includes(asset.conceptId)));
  const listed = spellings.map((spelling) => named.find((asset) => asset.conceptId === spelling)).find(Boolean);
  const source = "sources" in scope ? scope.sources[0] : undefined;
  if (listed || !source?.registryId) return listed;
  // A spelling the adapter reads but does not list under (another letter case). One with a type folder in front is
  // not tried: reading it would resolve an outdated spelling of another asset, with a warning.
  for (const spelling of spellings) {
    if (withoutTypeHead(spelling) !== undefined) continue;
    const asset = readFrom(source, source.registryId, spelling);
    if (asset && taskAssetsAmong([asset]).length > 0) return asset;
  }
  return undefined;
}

/**
 * The name `input` gives a task in the bundle: the id without the prefix its adapter places tasks under. An adapter
 * that places tasks names one by a bare id or by `tasks/<id>`, nothing deeper.
 */
export function taskNameOf(source: TaskBundleSource, input: string): string {
  if (!adapterWrites(source, "task")) return input;
  const prefix = taskPrefixIn(source);
  const name = prefix !== "" && input.startsWith(prefix) ? input.slice(prefix.length) : input;
  if (name.includes("/")) {
    throw new UsageError(
      `The native akm adapter accepts only a bare task id or tasks/<id>, got "${input}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  return name;
}

/** Refuse a bundle whose adapter declares no task type: it defines no task identity. */
function refuseWithoutTasks(source: TaskBundleSource): void {
  if (adapterDeclares(source, "task")) return;
  throw new UsageError(
    `Bundle adapter ${JSON.stringify(bundleAdapterId(source))} does not define task runtime identity.`,
    "INVALID_FLAG_VALUE",
  );
}

/** The task `input` names in a source's bundle, with its id; undefined when it holds none. Refuses what base refused. */
export function resolveTask(source: TaskBundleSource, input: string): { asset: Asset; id: string } | undefined {
  refuseWithoutTasks(source);
  const asset = findTask(taskScopeOf(source), taskNameOf(source, input));
  if (asset === undefined) return undefined;
  return { asset, id: taskIdOf(asset, source) };
}

/** The sentence for a task a bundle does not hold, naming the id and the adapter. */
export function taskNotFound(source: TaskBundleSource, shown: string): NotFoundError {
  return new NotFoundError(
    `Task ${JSON.stringify(shown)} was not found in the configured ${JSON.stringify(bundleAdapterId(source))} bundle.`,
    "ASSET_NOT_FOUND",
  );
}

/** The lowercase ids of the tasks held in a `.yml` file, among a bundle's `listing`: a task held in another spelling of the extension yields to them. */
export function ymlHeldIds(listing: readonly Asset[], source: TaskBundleSource): Set<string> {
  const held = listing.filter((asset) => taskFileOf(asset).endsWith(".yml"));
  return new Set(taskAssetsAmong(held).map((asset) => taskIdOf(asset, source).toLowerCase()));
}

/** Whether `asset`, held in an off-case file, is shadowed by a `.yml`-held task of the same id (compared case-insensitively). */
export function isShadowedByYml(asset: Asset, id: string, claimed: ReadonlySet<string>): boolean {
  return !taskFileOf(asset).endsWith(".yml") && claimed.has(id.toLowerCase());
}

/**
 * The ref of the task `input` names in `source`'s bundle: the task's own, else the one a task of that id would have
 * (where its adapter would place it), so a task whose file is gone still has the ref its activation was stored under.
 */
export function taskRefIn(source: TaskBundleSource, input: string, options: { refuse?: boolean } = {}): string {
  if (options.refuse !== false) refuseWithoutTasks(source);
  const name = taskNameOf(source, input);
  const found = findTask(taskScopeOf(source), name);
  if (found) return found.ref;
  // An adapter that writes no task places none: a task there is named by its concept id.
  return makeBundleRef(
    source.name,
    adapterWrites(source, "task") ? addressOf(source, conceptIdFromTypeName("task", name)).conceptId : name,
  );
}
