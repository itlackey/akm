import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { launchFixture } from "./support.mjs";

test("built desktop UI: isolated human asset and proposal workflows", { timeout: 240000 }, async (t) => {
  const server = await launchFixture({ proposals: true });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "screenshots");
  await mkdir(screenshots, { recursive: true });
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: new RegExp(`^${name}(?:\\s|$)`) });
  const inspector = page.getByRole("region", { name: "Asset workspace", exact: true });
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const showSearch = async () => {
    if (await page.getByRole("searchbox", { name: "Search library" }).isVisible()) return;
    const searchTab = page
      .getByRole("navigation", { name: "Library views" })
      .getByRole("link", { name: "Search", exact: true });
    const searchReturn = page.getByRole("link", { name: "Search results", exact: true });
    if (await searchTab.isVisible()) {
      await searchTab.click();
      await expect(searchReturn.or(page.getByRole("searchbox", { name: "Search library" }))).toBeVisible();
    }
    if (await searchReturn.isVisible()) await searchReturn.click();
    else if (!(await page.getByRole("searchbox", { name: "Search library" }).isVisible()))
      await page.evaluate(() => {
        location.hash = "#/search";
      });
    await expect(page.getByRole("searchbox", { name: "Search library" })).toBeVisible();
  };
  const search = async (query) => {
    await showSearch();
    await page.getByRole("searchbox", { name: "Search library" }).fill(query);
    const response = page.waitForResponse((r) => r.url().includes("/api/search?") && r.status() === 200);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await response;
  };
  const openResult = (text) =>
    page
      .getByRole("region", { name: "Search results" })
      .getByRole("link")
      .filter({ hasText: text.replaceAll("-", " ") })
      .first()
      .click();
  const type = async (value) => {
    await showSearch();
    const filters = page.locator(".search-filters");
    if (!(await filters.evaluate((el) => el.open))) await filters.locator("summary").click();
    await filters.getByRole("combobox", { name: "Type", exact: true }).selectOption(value);
    const response = page.waitForResponse((r) => r.url().includes("/api/search?") && r.status() === 200);
    await filters.getByRole("button", { name: "Apply filters", exact: true }).click();
    await response;
  };
  const editor = () => page.getByRole("textbox", { name: "Markdown source, including optional frontmatter" });

  await t.test("starts with real data, hostname/version, and responsive readable layout", async () => {
    await page.goto(server.url + "#/search");
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    assert.equal(requests.includes("/api/overview"), false, "Activity is loaded only when visited");
    assert.equal(requests.includes("/api/config"), false, "Settings is loaded only when visited");
    await search("backup");
    await expect(page.locator(".host")).toContainText("AKM");
    await openResult("restore-laptop");
    await expect(page.locator(".markdown")).toContainText("Verify the checksum");
    await page.screenshot({ path: path.join(screenshots, "library-desktop.png"), fullPage: true });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(screenshots, "library-narrow.png"), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    } finally {
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  });

  await t.test("edits through AKM, detects outside changes, and retains both versions for review", async () => {
    await page.getByRole("link", { name: "Edit page", exact: true }).click();
    const draft = `${await editor().inputValue()}\nHuman edit from the desktop.\n`;
    await editor().fill(draft);
    await nav("Settings").click();
    await page
      .getByRole("dialog", { name: "Leave this draft?" })
      .getByRole("button", { name: "Leave and keep draft", exact: true })
      .click();
    await nav("Library").click();
    assert.equal(await editor().inputValue(), draft, "Section changes must preserve an unsaved draft");
    await writeFile(server.documentPath, `${server.content}\nConcurrent edit from another client.\n`);
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A newer version exists" })).toBeVisible();
    assert.equal(await editor().inputValue(), draft);
    await expect(page.locator(".conflict")).toContainText("Concurrent edit from another client.");
    await editor().fill(`${draft}\nConcurrent edit from another client.\n`);
    let releaseSave;
    const saveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    let saveReturned;
    const savedResponse = new Promise((resolve) => {
      saveReturned = resolve;
    });
    await page.route(
      "**/api/desktop/file/save",
      async (route) => {
        const response = await route.fetch();
        saveReturned();
        await saveGate;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Save reviewed version", exact: true }).click();
    await savedResponse;
    try {
      await page
        .getByRole("navigation", { name: "Library views" })
        .getByRole("link", { name: "Files", exact: true })
        .click();
      await expect(page.getByRole("dialog", { name: "Leave this draft?" })).toBeVisible();
    } finally {
      releaseSave();
    }
    // The editor's hidden Preview already contains the draft. Wait for the
    // saved reader, not that preview, before starting the next workflow.
    await expect(page.locator(".document-body")).toBeVisible();
    await expect(page.locator(".document-body")).toContainText("Human edit from the desktop.");
    await expect(page.getByRole("dialog", { name: "Leave this draft?" })).not.toBeVisible();
    assert.match(await readFile(server.documentPath, "utf8"), /Concurrent edit from another client/);
  });

  await t.test("creates knowledge via the packaged CLI child and offers it in search", async () => {
    await page
      .getByRole("navigation", { name: "Library views" })
      .getByRole("link", { name: "Files", exact: true })
      .click();
    await page.getByRole("link", { name: /New knowledge/ }).click();
    await page.getByRole("textbox", { name: "File name", exact: true }).fill("desktop-created");
    await editor().fill("# Desktop created\n\nA synthetic note written by the UI through AKM.\n");
    const created = page.waitForResponse(
      (r) => r.url().endsWith("/api/knowledge/create") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create knowledge", exact: true }).click();
    assert.equal((await created).status(), 200);
    await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
    assert.match(
      await readFile(path.join(server.root, "personal/knowledge/desktop-created.md"), "utf8"),
      /synthetic note written/,
    );
    await search("desktop-created");
    await openResult("desktop-created");
    await expect(page.locator(".markdown")).toContainText("A synthetic note written by the UI");
  });

  await t.test("copies a complete skill package without altering the original", async () => {
    const sourcePath = path.join(server.root, "personal/skills/backup-check/SKILL.md");
    const sourceBefore = await readFile(sourcePath, "utf8");
    await type("skill");
    await search("backup-check");
    await openResult("backup-check");
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Copy to bundle…", exact: true }).click();
    await page.getByRole("combobox", { name: "Destination bundle", exact: true }).selectOption("shared");
    const copied = page.waitForResponse((r) => r.url().endsWith("/api/asset/copy") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Confirm copy", exact: true }).click();
    assert.equal((await copied).status(), 200);
    await expect(page.getByRole("status").filter({ hasText: "Copy completed" })).toBeVisible();
    assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);
    const copiedSkill = await readFile(path.join(server.root, "shared/skills/backup-check/SKILL.md"), "utf8");
    assert.match(copiedSkill, /sources:\n  - personal\/\/skills\/backup-check/);
    assert.equal(copiedSkill.replace("sources:\n  - personal//skills/backup-check\n", ""), sourceBefore);
    for (const file of ["references/checklist.md", "scripts/check.sh"]) {
      assert.equal(
        await readFile(path.join(server.root, "personal/skills/backup-check", file), "utf8"),
        await readFile(path.join(server.root, "shared/skills/backup-check", file), "utf8"),
      );
    }
    const refusal = await server.call("/api/asset/copy", { sourceRef: server.refs.skill, target: "shared" });
    assert.notEqual(refusal.status, 200);
  });

  await t.test("read-only content has no edit action and malicious Markdown cannot execute", async () => {
    await type("");
    await search("vendor-backup");
    await openResult("vendor-backup");
    await expect(page.locator(".markdown")).toContainText("Use the vendor tool.");
    await expect(page.getByRole("link", { name: "Edit page", exact: true })).toHaveCount(0);
    await search("untrusted");
    await openResult("untrusted");
    await expect(page.locator(".markdown")).toContainText("Untrusted");
    assert.equal(await page.evaluate(() => window.__akmInjected), undefined);
    assert.equal(
      await page
        .locator('.markdown script, .markdown img, .markdown [onerror], .markdown a[href^="javascript:"]')
        .count(),
      0,
    );
  });

  await t.test("compares two real assets and records useful feedback through AKM", async () => {
    await type("knowledge");
    await search("backup");
    const results = page.getByRole("region", { name: "Search results" });
    await page.getByRole("button", { name: "Compare assets", exact: true }).click();
    const choices = results.getByRole("checkbox");
    assert.ok((await choices.count()) >= 2);
    await choices.nth(0).check();
    await choices.nth(1).check();
    await page.getByRole("link", { name: "Compare", exact: true }).click();
    await expect(page.locator(".change-preview")).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "compare-desktop.png"), fullPage: true });
    await page.getByRole("link", { name: "Close comparison", exact: true }).click();
    await openResult("restore-laptop");
    await page.getByRole("button", { name: "Add feedback", exact: true }).click();
    await expect(inspector.getByRole("region", { name: "Feedback", exact: true })).toBeVisible();
    await expect(inspector.getByRole("heading", { name: "Give feedback", exact: true })).toBeVisible();
    const feedback = page.waitForResponse((r) => r.url().endsWith("/api/feedback") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Record feedback", exact: true }).click();
    assert.equal((await feedback).status(), 200);
    await expect(page.getByRole("status").filter({ hasText: "Feedback recorded." })).toBeVisible();
  });

  await t.test("rejects and reopens a real proposal, then accepts another", async () => {
    await nav("Review").click();
    await page.getByRole("button", { name: "Refresh queue" }).click();
    await page
      .getByRole("region", { name: "Proposals" })
      .getByRole("link")
      .filter({ hasText: "review example" })
      .click();
    await page.getByRole("button", { name: "Reject…", exact: true }).click();
    await page.getByRole("textbox", { name: "Rejection reason" }).fill("Synthetic review: verify the evidence first.");
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Proposal detail" }).getByRole("button", { name: "Reopen…", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("region", { name: "Proposal detail" })
      .getByRole("button", { name: "Reopen…", exact: true })
      .click();
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    await expect(page.getByRole("button", { name: "Accept…", exact: true })).toBeVisible();
    await page
      .getByRole("region", { name: "Proposals" })
      .getByRole("link")
      .filter({ hasText: "recovery checklist" })
      .click();
    await page.screenshot({ path: path.join(screenshots, "review-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Accept…", exact: true }).click();
    const accepted = page.waitForResponse(
      (r) => r.url().includes(`/api/proposals/${server.proposals.fresh}/accept`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    assert.equal((await accepted).status(), 200);
    await expect(page.getByRole("status").filter({ hasText: "Decision recorded" })).toBeVisible();
    assert.match(
      await readFile(path.join(server.root, "personal/knowledge/recovery-checklist.md"), "utf8"),
      /Preserve the original backup/,
    );
    const stale = await server.call(`/api/proposals/${server.proposals.stale}/accept`, {});
    assert.equal(stale.status, 409);
    assert.match(await readFile(server.documentPath, "utf8"), /Human edit from the desktop/);
  });

  await t.test("reports partial batch outcomes and reverts an accepted proposal", async () => {
    await page
      .getByRole("region", { name: "Proposals" })
      .getByRole("checkbox", { name: /restore-laptop/ })
      .check();
    await page
      .getByRole("region", { name: "Proposals" })
      .getByRole("checkbox", { name: /review-example/ })
      .check();
    await page.getByRole("button", { name: "Accept selected…", exact: true }).click();
    const batch = page.waitForResponse(
      (r) => r.url().endsWith("/api/proposals/accept") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    assert.equal((await batch).status(), 200);
    await expect(page.getByRole("status").filter({ hasText: "Decision recorded" })).toContainText(
      "1 completed · 1 failed",
    );
    await expect(
      page.getByRole("region", { name: "Proposals" }).getByRole("checkbox", { name: /restore-laptop/ }),
    ).toBeChecked();
    await page.getByRole("link", { name: "Recent decisions", exact: true }).click();
    await page
      .getByRole("region", { name: "Proposals" })
      .getByRole("link")
      .filter({ hasText: "review example" })
      .click();
    await page.getByRole("button", { name: "Revert accepted change…", exact: true }).click();
    const reverted = page.waitForResponse(
      (r) => r.url().includes(`/api/proposals/${server.proposals.reject}/revert`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
    assert.equal((await reverted).status(), 200);
    assert.match(
      await readFile(path.join(server.root, "personal/knowledge/review-example.md"), "utf8"),
      /Original review guidance retained for the rollback check/,
    );
    assert.match(await readFile(server.documentPath, "utf8"), /Human edit from the desktop/);
  });

  await t.test("existing activity/settings remain reachable without console failures", async () => {
    await nav("Activity").click();
    await expect(page.getByRole("heading", { name: "Health", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "activity-desktop.png"), fullPage: true });
    await page.getByRole("link", { name: "Improve impact", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Is review keeping up?", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "impact-desktop.png"), fullPage: true });
    await nav("Settings").click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "settings-desktop.png"), fullPage: true });
    assert.deepEqual(errors, []);
  });

  await t.test("manages existing bundle settings and validated configuration", async () => {
    const shared = page.getByRole("article", { name: "Bundle shared", exact: true });
    await shared.getByRole("link", { name: "Manage shared", exact: true }).click();
    const management = page.getByRole("article", { name: "Manage bundle shared", exact: true });
    await management.getByRole("switch", { name: "Enabled", exact: true }).uncheck();
    const disabled = page.waitForResponse(
      (r) => r.url().endsWith("/api/bundles/settings") && r.request().method() === "POST",
    );
    await management.getByRole("button", { name: "Save shared settings", exact: true }).click();
    assert.equal((await disabled).status(), 200);
    await expect(management.getByRole("button", { name: "Save shared settings", exact: true })).toBeEnabled();
    await page.getByRole("link", { name: "Back to bundles", exact: true }).click();
    await expect(shared.locator(".card-head")).toContainText("Disabled");
    await shared.getByRole("link", { name: "Manage shared", exact: true }).click();
    await management.getByRole("switch", { name: "Enabled", exact: true }).check();
    const enabled = page.waitForResponse(
      (r) => r.url().endsWith("/api/bundles/settings") && r.request().method() === "POST",
    );
    await management.getByRole("button", { name: "Save shared settings", exact: true }).click();
    assert.equal((await enabled).status(), 200);
    await expect(management.getByRole("button", { name: "Save shared settings", exact: true })).toBeEnabled();
    await page.getByRole("link", { name: "Back to bundles", exact: true }).click();
    await expect(shared.locator(".card-head")).toContainText("Enabled");
    await page.getByRole("link", { name: "Configuration", exact: true }).click();
    await page.getByRole("link", { name: "Library defaults", exact: true }).click();
    await page.getByRole("combobox", { name: "Default write target", exact: true }).selectOption("shared");
    const configured = page.waitForResponse(
      (r) => r.url().endsWith("/api/config/set") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save library defaults", exact: true }).click();
    assert.equal((await configured).status(), 200);
    const config = JSON.parse(await readFile(path.join(server.root, "config/config.json"), "utf8"));
    assert.equal(config.defaultWriteTarget, "shared");
    assert.deepEqual(errors, []);
  });
  console.log(`Screenshots: ${screenshots}`);
});
