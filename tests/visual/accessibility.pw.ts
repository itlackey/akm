// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Forced colors and `prefers-contrast: more` (set by the project) for the gallery, Overview and a proposal's detail. */

import { type TestInfo, test } from "@playwright/test";
import { ROUTES, shoot, visit, visitGallery } from "./support";

// Increased contrast draws the gallery and a proposal's detail exactly as light does, so only Overview is shot in it.
function skipIfSameAsLight({ project }: TestInfo, name: string): void {
  test.skip(project.name.endsWith("contrast-more") && name !== "overview", "draws the same as light");
}

test("gallery", async ({ page }, testInfo) => {
  skipIfSameAsLight(testInfo, "gallery");
  await visitGallery(page);
  await shoot(page, "gallery--loaded");
});

for (const name of ["overview", "proposal-edit"] as const) {
  test(name, async ({ page }, testInfo) => {
    skipIfSameAsLight(testInfo, name);
    await visit(page, ROUTES[name].hash);
    await shoot(page, `${name}--loaded`);
  });
}
