// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The children akm starts asynchronously, for a host that stops them on shutdown (akm-web). A host calls
 * `startChildrenInOwnGroups` before akm starts any, reads `runningChildren` and signals each with `signalChild`.
 * `spawnChild` starts a child of the host's own on the same record.
 */

export {
  onChildStarted,
  runningChildren,
  type StartedChild,
  signalChild,
  spawnChild,
  startChildrenInOwnGroups,
} from "../core/children";
