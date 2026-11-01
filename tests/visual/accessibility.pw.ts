// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Forced colors and `prefers-contrast: more` (set by the project) for the gallery, Overview and a proposal's detail (plan 11.2). */

import { test } from "@playwright/test";
import { ROUTES, shoot, visit, visitGallery } from "./support";

test("gallery", async ({ page }) => {
  await visitGallery(page);
  await shoot(page, "gallery--loaded");
});

for (const name of ["overview", "proposal-edit"] as const) {
  test(name, async ({ page }) => {
    await visit(page, ROUTES[name].hash);
    await shoot(page, `${name}--loaded`);
  });
}
