// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The 320px reflow check (WCAG 1.4.10): a route's page may not scroll sideways. No screenshot is taken. */

import { expect, test } from "@playwright/test";
import { ROUTES, type RouteName, visit } from "./support";

for (const name of Object.keys(ROUTES) as RouteName[]) {
  test(`${name} reflows at 320`, async ({ page }) => {
    await visit(page, ROUTES[name].hash);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
  });
}
