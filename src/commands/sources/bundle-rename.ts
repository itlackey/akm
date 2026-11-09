// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { renameBundle } from "../../sources/bundle-rename";
import { akmTasksSync } from "../tasks/tasks";

/** `akm bundle rename`: rename a configured bundle everywhere akm persists it, then re-sync its scheduled tasks. */
export function akmBundleRename(oldId: string, newId: string, options: { dryRun?: boolean } = {}) {
  return renameBundle(oldId, newId, options, { syncTasks: (id, backend) => akmTasksSync({ backend }, id) });
}
