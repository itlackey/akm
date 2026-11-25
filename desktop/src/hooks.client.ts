// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { resolve } from "$app/paths";
import { setRoot } from "./lib/client";

// Where the UI is served from, set once before anything loads. Kit 3 has no `base` export: the root route is the base
// path and a slash.
setRoot(resolve("/").slice(0, -1));
