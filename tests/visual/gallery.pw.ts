// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The gallery of shared builders and controls, served on the UI origin (plan 8.7). */

import { test } from "@playwright/test";
import { shoot, visitGallery } from "./support";

test("gallery loaded", async ({ page }) => {
  await visitGallery(page);
  await shoot(page, "gallery--loaded");
});
