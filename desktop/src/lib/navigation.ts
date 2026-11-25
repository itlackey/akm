// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { goto } from "$app/navigation";
import { resolve } from "$app/paths";
import { appHref, setRoot } from "./client";

// Kit 3 has no `base` export; the root route is the base path and a slash.
setRoot(resolve("/").slice(0, -1));

/** Use Kit navigation so native Back/Forward participates in beforeNavigate.
 * Shallow history entries intentionally skip that lifecycle on popstate.
 */
export async function navigate(href: string, replace = false) {
  await goto(appHref(href), { state: {}, replace, reset: false });
}
