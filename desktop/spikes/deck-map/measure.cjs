// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Opens the built spike in Chromium, takes screenshots and reads frame rates for each scenario.
//   node measure.cjs <dist-dir> <screenshot-dir> [--gpu]
// Without --gpu Chromium renders with SwiftShader (software), so frame rates are a floor, not what a desktop GPU gives.

const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const [dist, shots, flag] = process.argv.slice(2);
const types = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html" };
const server = http
  .createServer((req, res) => {
    const file = path.join(
      dist,
      decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : req.url.split("?")[0],
    );
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  })
  .listen(0);

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const args = flag === "--gpu" ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  const browser = await chromium.launch({ args });
  const results = {};
  for (const scheme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, colorScheme: scheme });
    page.on("pageerror", (e) => console.log("pageerror", e.message));
    page.on("console", (m) => m.type() === "error" && console.log("console", m.text()));
    const t0 = Date.now();
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.waitForFunction(() => window.spike, null, { timeout: 120000 });
    const loadMs = Date.now() - t0;
    const settle = async (ms = 3000) => {
      await page.waitForTimeout(ms);
      return page.evaluate(() => ({ fps: Math.round(window.spike.fps), renderMs: +window.spike.renderMs.toFixed(1) }));
    };
    const shot = (name) => page.screenshot({ path: path.join(shots, `${scheme}-${name}.png`) });
    if (scheme === "light") {
      await settle(1500);
      await shot("meaning");
      await page.evaluate(() => window.spike.setMode("links"));
      await page.waitForFunction(() => window.spike.layout.done, null, { timeout: 600000 });
      await settle(1500);
      await shot("links");
      await page.close();
      continue;
    }
    results.loadMs = loadMs;
    results.idle = await settle();
    await shot("meaning");
    // Click the best-connected asset that is on screen.
    const at = await page.evaluate(() => {
      const d = window.spike.degree;
      let best = 0;
      for (let i = 0; i < d.length; i++) if (d[i] > d[best]) best = i;
      window.spike.select(best);
      return best;
    });
    results.selectedIndex = at;
    results.selected = await settle(2000);
    await shot("selected");
    await page.evaluate(() => window.spike.select(-1, false));
    await page.evaluate(() => window.spike.setMode("links"));
    await page.waitForFunction(() => window.spike.layout.done, null, { timeout: 600000 });
    results.layout = await page.evaluate(() => ({ ...window.spike.layout }));
    await page.evaluate(() => window.spike.fit(undefined, 0));
    results.links = await settle(2500);
    await shot("links");
    for (const perSecond of [200, 1000]) {
      await page.evaluate((r) => window.spike.setActivity(true, r), perSecond);
      results[`activity${perSecond}`] = {
        ...(await settle(4000)),
        pulses: await page.evaluate(() => window.spike.pulses),
      };
    }
    await shot("activity");
    await page.evaluate(() => window.spike.setActivity(false));
    await page.mouse.move(700, 430);
    await page.waitForTimeout(500);
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(1500);
    await shot("zoomed");
    await page.close();
  }
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
})();
