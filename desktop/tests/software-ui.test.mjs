import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect } from "@playwright/test";
import { launchFixture } from "./support.mjs";

test("Software uses authenticated native actions, shows receipts, preserves the workspace and fits the established UI", {
  timeout: 120000,
}, async (t) => {
  const server = await launchFixture({
    configureFixture: async (fixture) => {
      const bin = path.join(fixture.root, "fake-tools");
      await mkdir(bin);
      fixture.env.PATH = bin;
      // Executable fixtures, not production host commands or replaced HTTP responses.
      for (const name of ["akm", "codex", "bun"])
        await writeFile(
          path.join(bin, name),
          `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),name=${JSON.stringify(name)};
fs.appendFileSync(${JSON.stringify(path.join(fixture.root, "commands.jsonl"))},JSON.stringify({name,args})+'\\n');
const installed=${JSON.stringify(path.join(fixture.root, "plugin-installed"))};
if(args[0]==='--version')console.log('0.10.261104');
else if(name==='akm')console.log(JSON.stringify({currentVersion:'0.10.261104',latestVersion:'0.10.261105',updateAvailable:true}));
else if(args[1]==='marketplace'&&args[2]==='list')console.log(JSON.stringify({marketplaces:[{name:'akm-plugins'}]}));
else if(args[1]==='list')console.log(JSON.stringify({installed:fs.existsSync(installed)?[{pluginId:'akm@akm-plugins',version:'0.10.261105'}]:[]}));
else if(args[1]==='add'){fs.writeFileSync(installed,'fixture');console.log('{}')}
else {process.exitCode=1}
`,
          { mode: 0o755 },
        );
    },
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Software", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Software", exact: true })).toBeVisible();
  await expect(page.getByText("Update available · 0.10.261105", { exact: true })).toBeVisible();
  await expect(page.getByText("To update, replace the AppImage with a newer download.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to application menu", exact: true })).toHaveCount(0);
  assert.equal((await server.call("/api/desktop/software", { action: "desktop-menu-install" })).status, 400);
  await page.getByRole("button", { name: "Install AKM plugin", exact: true }).click();
  await expect(
    page.getByText("AKM installed for Codex. Review its hooks in Codex /hooks to enable automatic recall.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Install AKM plugin", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Update CLI & plugins", exact: true }).click();
  await expect(
    page.getByText("Native AKM upgrade completed. The bundled desktop engine is unchanged.", { exact: true }),
  ).toBeVisible();
  const commands = (await readFile(path.join(server.root, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(commands.some((item) => item.name === "akm" && item.args.join(" ") === "upgrade --format json"));
  assert.ok(commands.some((item) => item.name === "codex" && item.args.join(" ") === "plugin add akm@akm-plugins"));
  assert.ok(!commands.some((item) => item.args.includes("trust") || item.args.includes("--allow-downgrade")));
  const output = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "screenshots");
  await mkdir(output, { recursive: true });
  for (const width of [1280, 900, 600]) {
    await page.setViewportSize({ width, height: 860 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `No horizontal overflow at ${width}`,
    );
    const axe = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(
      axe.violations.map((v) => v.id),
      [],
    );
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `software-${width}.png`), fullPage: true });
  }
});
