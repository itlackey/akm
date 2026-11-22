// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { secretStoreOf } from "../../core/adapter/registry";
import { listSecretNames, secretConceptId } from "../../core/adapter/secret-store";
import type { BundleComponent } from "../../core/adapter/types";
import { toErrorMessage } from "../../core/common";
import { buildFileContext } from "../walk/file-context";
import type { WalkStashFlatResult } from "../walk/walker";

/**
 * A secret store bundle's entries in the shape a walk gives a directory's
 * files, or undefined for a directory bundle. Each secret is the file
 * `secrets/<name>` under the bundle's root, which exists only as that path:
 * the adapter recognizes an entry from it and nothing reads it. A store that
 * cannot be listed is an incomplete walk, so the index keeps the entries it had.
 */
export function listStoreEntries(component: BundleComponent): WalkStashFlatResult | undefined {
  const store = secretStoreOf({ adapterId: component.adapter, locator: component.locator });
  if (!store) return undefined;
  try {
    const files = listSecretNames(store).map((name) =>
      buildFileContext(component.root, path.join(component.root, secretConceptId(name))),
    );
    return { files, complete: true };
  } catch (error) {
    return { files: [], complete: false, incompleteReason: toErrorMessage(error) };
  }
}
