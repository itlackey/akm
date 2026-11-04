// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The host's folders, for a bundle-add picker. This is not akm data; it leaves akm once akm ui is removed. */

import { listFolders } from "./folders";

export function folders(input: { path: string; hidden?: boolean }) {
  return listFolders(input.path ?? "", input.hidden === true);
}
