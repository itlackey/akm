import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { launchFixture } from "./support.mjs";

test("Attention desk is the default, preserves deep links, and uses recorded read-only measurements", {
  timeout: 180000,
}, async (t) => {
  const server = await launchFixture({ metrics: true, proposals: true });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [],
    requests = [];
  await page.route("**/api/overview?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.health.advisories.push({
      name: "fixture-source-access",
      status: "warn",
      message: "Synthetic warning for an unavailable source folder.",
    });
    await route.fulfill({ response, json: body });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) =>
    requests.push({ path: new URL(request.url()).pathname, url: request.url(), method: request.method() }),
  );
  const home = page.locator(".home-page");
  const nav = (name) =>
    page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name, exact: true });
  await page.goto(server.url);
  await expect(home.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(nav("Home")).toHaveAttribute("aria-current", "page");
  assert.equal(
    requests.some((row) => row.method !== "GET"),
    false,
  );
  assert.equal(
    requests.some((row) => row.path === "/api/search" || row.path === "/api/health" || row.url.includes("probe=1")),
    false,
  );
  const observed = (await server.call("/api/overview/pulse")).body.data;
  const pending = (await server.call("/api/proposals?status=pending&limit=1")).body.data.fullCount;
  await expect(home.getByRole("heading", { name: `${pending} proposed changes` })).toBeVisible();
  await expect(home.locator(".home-run-bar")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${observed.tiles.runs.tasks.ok} completed, ${observed.attention.failedRuns.tasks} failed`),
  );
  await expect(home.locator(".home-concerns")).not.toContainText("proposals");

  const output = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "home-screenshots");
  await mkdir(output, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.getByRole("combobox", { name: "Appearance" }).selectOption(theme);
    for (const width of [320, 640, 900, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${theme} ${width}: no overflow`,
      );
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      assert.deepEqual(
        result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
        [],
      );
      if ([320, 1280].includes(width))
        await page.screenshot({ path: path.join(output, `home-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("combobox", { name: "Appearance" }).selectOption("light");
  const refresh = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/overview");
  await home.getByRole("button", { name: "Check health", exact: true }).click();
  await refresh;
  await expect(home.getByRole("button", { name: "Check health", exact: true })).toBeEnabled();
  assert.equal(
    requests.some((row) => row.path === "/api/health" || row.url.includes("probe=1")),
    false,
    "Home checks local diagnostics; explicit network probes remain in Activity",
  );
  await home.getByRole("link", { name: "View runs: 1 task run failed", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Trend window" })).toHaveValue("7d");
  await page.getByRole("button", { name: "synthetic-failure", exact: true }).click();
  await expect(page.getByRole("region", { name: "Task run details" })).toContainText("failed");
  await nav("Home").click();
  const check = home.getByRole("link", { name: /^Inspect:/ }).first();
  {
    await expect(check).toBeVisible();
    const anchor = new URLSearchParams((await check.getAttribute("href")).split("?")[1]).get("anchor");
    await check.click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(anchor);
    await nav("Home").click();
  }
  await home.getByRole("link", { name: "Review proposals" }).click();
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await page.goBack();
  await expect(home.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await home.getByRole("link", { name: "Create an asset" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown source, including optional frontmatter" });
  await expect(editor).toBeVisible();
  await editor.fill("# A retained Home navigation draft");
  await nav("Home").click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave and keep draft" }).click();
  await expect(home.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await nav("Library").click();
  await expect(editor).toHaveValue("# A retained Home navigation draft");
  await page.getByRole("button", { name: "Discard draft…", exact: true }).click();
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await page.getByRole("link", { name: "Cancel", exact: true }).click();
  await expect(home.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(page).toHaveURL(/#\/home$/);
  await page.goto(server.origin + "/#/search");
  await expect(page.getByRole("searchbox", { name: "Search library" })).toBeVisible();
  await nav("Home").click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("searchbox", { name: "Search library" })).toBeFocused();
  assert.deepEqual(errors, []);
  console.log(`Home screenshots: ${output}`);
});

test("Home failure and empty states never present unavailable measurements as healthy", {
  timeout: 60000,
}, async (t) => {
  const server = await launchFixture();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  let broken = true;
  const empty = {
    health: { status: "pass", hardChecks: [], advisories: [] },
    metrics: { tasks: { runs: 0, failed: 0 } },
    improveRuns: [],
    taskFailures: [],
  };
  const pulse = { tiles: { runs: { tasks: { ok: 0, total: 0 } } }, attention: { failedRuns: { tasks: 0 } } };
  await page.route("**/api/overview*", (route) =>
    route.fulfill(
      broken
        ? { status: 503, json: { ok: false, error: { message: "Synthetic measurement failure" } } }
        : { json: { ok: true, data: new URL(route.request().url()).pathname.endsWith("/pulse") ? pulse : empty } },
    ),
  );
  await page.route("**/api/proposals?*", (route) =>
    route.fulfill({ status: 503, json: { ok: false, error: { message: "Synthetic queue failure" } } }),
  );
  await page.goto(server.url);
  const home = page.locator(".home-page");
  await expect(home.getByText("Incomplete snapshot", { exact: true })).toBeVisible();
  await expect(home.getByRole("heading", { name: "Review queue unavailable" })).toBeVisible();
  await expect(home.locator(".home-run-bar")).toHaveCount(0);
  await expect(home.getByRole("heading", { name: "No issues in the available records" })).toHaveCount(0);
  await expect(home.getByRole("link", { name: "Find an asset" })).toBeVisible();
  broken = false;
  await home.getByRole("button", { name: "Retry overview" }).click();
  await expect(home.getByText("No task runs recorded in the past 7 days.")).toBeVisible();
  await expect(home.getByRole("heading", { name: "No issues in the available records" })).toBeVisible();
  await expect(home.getByText("Incomplete snapshot", { exact: true })).toHaveCount(0);
});
