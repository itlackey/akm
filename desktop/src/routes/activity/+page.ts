// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { redirect } from "@sveltejs/kit";
import { appHref } from "../../lib/client";

export const load = () => redirect(307, appHref("/activity/overview"));
