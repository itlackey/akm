// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A task is an asset, named by its ref. A bare task id is CLI sugar for it, resolved here and nowhere else: through
 * the bundle's task assets, by concept id as written, else by name (the concept id without the task type's folder).
 * No caller computes where an adapter keeps its tasks. This is the one function the ref qualifier replaces.
 */

import { stashDirFor } from "../core/asset/asset-placement";
import { makeBundleRef } from "../core/asset/asset-ref";
import { conceptIdFromTypeName } from "../core/asset/resolve-ref";
import { adapterWrites } from "../core/assets/gate";
import { type Asset, listAssets, readFrom } from "../core/assets/read";
import { assetTypes } from "../core/assets/type";
import { addressOf } from "../core/assets/write";
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
export function taskScopeOf(source: TaskBundleSource): TaskScope {
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
  // A spelling the adapter reads but does not list under (another letter case, an outdated type-folder spelling).
  for (const spelling of spellings) {
    const asset = readFrom(source, source.registryId, spelling);
    if (asset && taskAssetsAmong([asset]).length > 0) return asset;
  }
  return undefined;
}

/** The task `input` names in a source's bundle, with its id. */
export function resolveTask(source: TaskBundleSource, input: string): { asset: Asset; id: string } | undefined {
  const asset = findTask(taskScopeOf(source), input);
  return asset === undefined ? undefined : { asset, id: taskIdOf(asset, source) };
}

/**
 * The ref of the task `input` names in `source`'s bundle: the task's own, else the one a task of that id would have
 * (where its adapter would place it), so a task whose file is gone still has the ref its activation was stored under.
 */
export function taskRefIn(source: TaskBundleSource, input: string): string {
  const found = findTask(taskScopeOf(source), input);
  if (found) return found.ref;
  return makeBundleRef(source.name, addressOf(source, conceptIdFromTypeName("task", input)).conceptId);
}
