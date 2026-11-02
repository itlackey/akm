// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The 1280x800 `wide` edge, light only: Overview and the pending Proposals list. */

import { test } from "@playwright/test";
import { ROUTES, shoot, visit } from "./support";

for (const name of ["overview", "proposals-pending"] as const) {
  test(`${name} wide`, async ({ page }) => {
    await visit(page, ROUTES[name].hash);
    await shoot(page, `${name}--loaded`);
  });
}
