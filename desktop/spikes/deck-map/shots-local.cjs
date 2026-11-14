// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Screenshots of the local graph, from a running `bun serve.ts`.
//   node shots-local.cjs <base-url> <screenshot-dir>
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const [base, dir] = process.argv.slice(2);
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  for (const scheme of ["dark", "light"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      colorScheme: scheme,
      deviceScaleFactor: 2,
    });
    page.on("pageerror", (e) => console.log("pageerror", e.message));
    await page.goto(base);
    await page.waitForFunction(() => window.local, null, { timeout: 60000 });
    const settle = async () => {
      await page.waitForFunction(() => window.local.settled, null, { timeout: 60000 });
      await page.evaluate(() => window.local.fit());
      await page.waitForTimeout(1200);
    };
    const shot = async (name) => {
      await settle();
      await page.screenshot({ path: path.join(dir, `${scheme}-${name}.png`), timeout: 120000 });
      console.log(scheme, name, await page.evaluate(() => window.local.count), "assets");
    };
    const examples = await page.evaluate(() => window.local.examples);
    await page.evaluate((ref) => window.local.centre(ref), examples[1]);
    await shot("1-one-step");
    if (scheme === "light") {
      await page.close();
      continue;
    }
    await page.evaluate(() => window.local.expandAll(1));
    await shot("2-two-steps-3d");
    await page.evaluate(() => window.local.setThree(false));
    await shot("3-two-steps-flat");
    await page.evaluate(() => window.local.setThree(true));
    await page.evaluate((ref) => window.local.centre(ref), examples[2]);
    await shot("4-akm-eval-similar-only");
    await page.evaluate((ref) => window.local.centre(ref), examples[0]);
    await shot("5-hub");
    await page.close();
  }
  await browser.close();
})();
