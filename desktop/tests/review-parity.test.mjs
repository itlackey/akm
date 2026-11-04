import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import {
  activityReturn,
  commitOutcome,
  conceptLocation,
  proposalHref,
  proposalId,
  rejectionError,
  rejectionReason,
} from "../src/lib/review-model.ts";
import { buildDiff } from "../src/lib/upstream/diff.js";
import { diffSection } from "../src/lib/upstream/diff-view.js";
import { launchFixture } from "./support.mjs";

test("review helpers preserve route filters and bound composed rejection reasons", () => {
  const params = new URLSearchParams("source=reflect&age=older&id=ignored");
  const href = proposalHref("id/with space", params);
  assert.equal(href, "#/proposals/id%2Fwith%20space?source=reflect&age=older");
  assert.equal(proposalId("proposals/id%2Fwith%20space", params), "id/with space");
  assert.equal(proposalId("proposals", new URLSearchParams("id=direct")), "direct");
  assert.equal(rejectionReason("Stale", "  verify target  "), "Stale: verify target");
  assert.equal(rejectionError("Stale", ""), "");
  assert.match(rejectionError("Other", ""), /required/);
  assert.match(rejectionError("Wrong", "a".repeat(2000)), /2000/);
  assert.match(commitOutcome(null), /No Git commit/);
  assert.match(commitOutcome({ sha: "1234567890", subject: "test" }), /Push status was not reported/);
  assert.equal(activityReturn("#/improve?since=365d&anchor=impact-drill"), "#/improve?since=365d&anchor=impact-drill");
  assert.equal(activityReturn("https://example.com"), null);
  assert.equal(activityReturn("#/improve-not-a-route"), null);
});

test("upstream diff retains alignment, changed-word marks, escaping and safety fallbacks", () => {
  const before = Array.from({ length: 30 }, (_, i) => `Evidence line ${i}: preserve source`).join("\n");
  const after = before.replace("line 15: preserve", "line 15: verify");
  const model = buildDiff(before, after);
  assert.equal(model.added, 1);
  assert.equal(model.removed, 1);
  assert.ok(model.parts.some((p) => p.type === "gap"));
  assert.ok(model.rows.some((r) => r.left?.marks?.some(([, changed]) => changed)));
  const view = diffSection({ before, after, unified: "", truncated: false });
  assert.match(view.markup.text, /data-diff-mode="side"/);
  assert.match(view.markup.text, /data-diff-mode="inline" aria-pressed="true"/);
  assert.match(view.markup.text, /class="dcol inline"/);
  assert.doesNotMatch(view.markup.text, /class="sbs"/);
  assert.match(diffSection({ before: null, after: "# New asset" }).markup.text, /class="dcol inline"/);
  assert.match(view.markup.text, /data-gap/);
  const malicious = diffSection({
    before: "same <script>bad()</script>",
    after: "same <img onerror=bad()>",
    unified: "",
  });
  assert.doesNotMatch(malicious.markup.text, /<script>|<img /);
  const redacted = diffSection({
    before: "PRIVATE-SOURCE",
    after: "PRIVATE-SOURCE",
    redacted: true,
    unified: "Sensitive source hidden.",
  });
  assert.doesNotMatch(redacted.markup.text, /PRIVATE-SOURCE/);
  const truncated = diffSection({
    before: "INCOMPLETE-SIDE",
    after: "INCOMPLETE-SIDE",
    truncated: true,
    unified: "@@ safe summary @@",
  });
  assert.doesNotMatch(truncated.markup.text, /INCOMPLETE-SIDE/);
  assert.match(truncated.markup.text, /plain diff is shown/);
});

test("queue locations distinguish same-named concepts without inventing physical paths", () => {
  assert.equal(conceptLocation("personal//knowledge/laptops/recovery"), "personal//knowledge/laptops");
  assert.equal(conceptLocation("personal//knowledge/servers/recovery"), "personal//knowledge/servers");
  assert.equal(conceptLocation("personal//recovery"), "personal//");
  assert.equal(conceptLocation("knowledge/recovery"), "knowledge");
});

test("Review parity: actual isolated decisions, addressable queue, rich diff and batch recovery", {
  timeout: 180000,
}, async (t) => {
  const server = await launchFixture({ proposals: true });
  t.after(() => server.stop());
  const aligned = JSON.parse(
    execFileSync(process.execPath, [fileURLToPath(new URL("./seed-review-parity.mjs", import.meta.url))], {
      env: { ...server.env, AKM_DESKTOP_TEST_ROOT: server.root },
      encoding: "utf8",
      timeout: 60000,
    })
      .trim()
      .split("\n")
      .at(-1),
  );
  execFileSync(process.execPath, [server.launcher, "index", "--full", "--format=json", "-q"], {
    env: server.env,
    timeout: 60000,
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const shots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, "screenshots");
  await mkdir(shots, { recursive: true });
  await page.goto(server.url);
  // A side-by-side preference left by an older build cannot override the new default.
  await page.evaluate(() => localStorage.setItem("akm-ui-diff-mode", "side"));
  await page.evaluate((id) => {
    location.hash = `#/proposals/${id}?source=reflect`;
  }, aligned.id);
  const detail = page.getByRole("region", { name: "Proposal detail", exact: true });
  await expect(detail.getByRole("heading", { name: "review aligned", exact: false })).toBeVisible();
  await expect(page.getByRole("region", { name: "Queue summary" })).toContainText("4 waiting for review");
  await expect(page.locator(".review-item[aria-current] .queue-location")).toHaveText("personal//knowledge");
  await page.setViewportSize({ width: 1280, height: 860 });
  const visibleDiffHeight = await detail.evaluate((element) => {
    const diff = element.querySelector(".change-preview .dcol.inline").getBoundingClientRect();
    const shelf = element.querySelector(".decision-shelf").getBoundingClientRect();
    const scroll = element.querySelector(".review-scroll").getBoundingClientRect();
    return Math.min(shelf.top, scroll.bottom, innerHeight) - Math.max(diff.top, scroll.top);
  });
  await page.screenshot({ path: path.join(shots, "review-change-first-1280.png"), fullPage: false });
  assert.ok(
    visibleDiffHeight >= 220,
    `The actual change needs at least 220px before the decision shelf; got ${visibleDiffHeight}px`,
  );
  console.info(`Review visible diff at 1280×860: ${visibleDiffHeight.toFixed(1)}px`);
  for (const [width, height, minimum] of [
    [390, 860, 180],
    [900, 620, 160],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      scrollTo(0, 0);
      document.querySelector(".review-scroll").scrollTop = 0;
    });
    const geometry = await detail.evaluate((element) => {
      const diff = element.querySelector(".change-preview .dcol.inline").getBoundingClientRect();
      const shelf = element.querySelector(".decision-shelf").getBoundingClientRect();
      const scroll = element.querySelector(".review-scroll").getBoundingClientRect();
      return {
        visibleDiffPx: Math.min(shelf.top, scroll.bottom, innerHeight) - Math.max(diff.top, scroll.top),
        actions: [...element.querySelectorAll(".decision-row button")].map((button) => {
          const r = button.getBoundingClientRect();
          return {
            visible: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
            height: Math.round(r.height),
          };
        }),
      };
    });
    await page.screenshot({ path: path.join(shots, `review-change-first-${width}.png`), fullPage: false });
    assert.ok(
      geometry.visibleDiffPx >= minimum,
      `At ${width}×${height}, the actual diff needs ${minimum}px; got ${geometry.visibleDiffPx}px`,
    );
    assert.ok(
      geometry.actions.every((action) => action.visible && action.height === geometry.actions[0].height),
      "Compact decision actions stay equally sized and reachable",
    );
    console.info(`Review visible diff at ${width}×${height}: ${geometry.visibleDiffPx.toFixed(1)}px`);
    await detail.getByRole("link", { name: "Back to queue", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Source", exact: true })).toBeVisible();
    await page
      .getByRole("region", { name: "Proposals", exact: true })
      .getByRole("link")
      .filter({ hasText: "review aligned" })
      .click();
    await expect(detail.getByRole("heading", { name: "review aligned", exact: false })).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(detail.getByRole("heading", { name: "Why AKM proposed this" })).toBeVisible();
  await expect(detail.locator("details.review-evidence")).toHaveCount(0);
  const firstSelection = page
    .getByRole("region", { name: "Proposals", exact: true })
    .getByRole("checkbox", { name: /^Select personal/ })
    .first();
  await firstSelection.check();
  await expect(detail.getByRole("button", { name: "Accept selected…", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Accept…", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Accept…", exact: true })).toBeVisible();
  await expect(detail).toContainText("synthetic-review-parity");
  await expect(detail).toContainText("0.82");
  await expect(detail.locator(".w")).not.toHaveCount(0);
  await expect(detail.locator(".dcol.inline")).toHaveCount(1);
  const actionHeights = await detail
    .locator(".decision-row .btn-row button")
    .evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
  assert.ok(
    actionHeights.length > 1 && actionHeights.every((height) => height === actionHeights[0]),
    "Adjacent decision controls have the same height",
  );
  await detail.getByRole("button", { name: "Side by side", exact: true }).click();
  await expect(detail.locator(".sbs")).toHaveCount(1);
  await detail.getByRole("button", { name: "Inline", exact: true }).click();
  await expect(detail.locator(".dcol.inline")).toHaveCount(1);
  await detail
    .getByRole("button", { name: /Show \d+ unchanged lines/ })
    .first()
    .click();
  await expect(detail.locator("[data-revealed]")).toBeFocused();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(shots, "review-aligned-light.png"), fullPage: true });
  // Compare the established AKM page on precisely the same generated source, not live data.
  const baseline = fork(fileURLToPath(new URL("./review-upstream-server.mjs", import.meta.url)), [], {
    env: { ...server.env, AKM_DESKTOP_TEST_ROOT: server.root },
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => {
    if (baseline.connected) baseline.send("shutdown");
  });
  const baselineReady = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic upstream UI did not start.")), 15000);
    baseline.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    baseline.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    baseline.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Upstream fixture exited ${code}`));
    });
  });
  const reference = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await reference.goto(`${baselineReady.url}#/proposals/${aligned.id}?source=reflect`);
  await expect(reference.getByRole("heading", { name: "Why akm proposed this", exact: true })).toBeVisible();
  await reference.screenshot({ path: path.join(shots, "review-upstream-reference.png"), fullPage: true });
  await reference.close();
  await page.getByRole("combobox", { name: "Waiting age" }).selectOption("older");
  await expect(page.getByRole("region", { name: "Queue summary" })).toContainText("4 waiting for review");
  await expect(page.getByRole("region", { name: "Proposals", exact: true })).toContainText("No proposals match");
  await page.goBack();
  await expect(detail.getByRole("heading", { name: "review aligned", exact: false })).toBeVisible();
  // Single-character shortcuts are off by default and scoped to Review.
  const reject = detail.getByRole("button", { name: "Reject…", exact: true });
  await reject.focus();
  await page.keyboard.press("r");
  await expect(page.getByRole("region", { name: "Confirm decision" })).toHaveCount(0);
  await page.getByText("Keyboard shortcuts", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Enable single-key shortcuts for this window" }).check();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: /^Settings/ })
    .focus();
  await page.keyboard.press("a");
  await expect(page.getByRole("region", { name: "Confirm decision" })).toHaveCount(0);
  await reject.focus();
  await page.keyboard.press("r");
  await expect(page.getByRole("region", { name: "Confirm decision" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Confirm decision" })).toHaveCount(0);
  await expect(reject).toBeFocused();
  await detail.getByRole("button", { name: "Reject…", exact: true }).click();
  await page.getByRole("radio", { name: "Stale", exact: true }).check();
  await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
  await expect(page.locator("[data-receipt]")).toContainText("Rejected");
  await expect(detail).toContainText("rejected");
  await detail.getByRole("button", { name: "Reopen…", exact: true }).click();
  await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Accept…", exact: true })).toBeEnabled();
  await detail.getByRole("button", { name: "Accept…", exact: true }).focus();
  await page.keyboard.press("a");
  await page.keyboard.press("a");
  await expect(page.locator("[data-receipt]")).toContainText("Accepted");
  assert.match(await readFile(aligned.file, "utf8"), /line 17: verify/);
  await expect(detail.getByRole("button", { name: "Revert accepted change…", exact: true })).toBeEnabled();
  await detail.getByRole("button", { name: "Revert accepted change…", exact: true }).focus();
  await page.keyboard.press("u");
  await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
  await expect(page.locator("[data-receipt]")).toContainText("Reverted");
  assert.equal(await readFile(aligned.file, "utf8"), aligned.before);
  // Cooperating API refuses the stale target while another independent proposal succeeds.
  await writeFile(server.documentPath, `${server.content}\nSynthetic outside edit.\n`);
  await page.getByRole("link", { name: "Pending", exact: true }).click();
  const list = page.getByRole("region", { name: "Proposals", exact: true });
  await list.getByRole("checkbox", { name: /restore-laptop/ }).check();
  await list.getByRole("checkbox", { name: /recovery-checklist/ }).check();
  await page.getByRole("button", { name: "Accept selected…", exact: true }).click();
  await page.getByRole("button", { name: "Confirm decision", exact: true }).click();
  await expect(page.locator("[data-receipt]")).toContainText("1 completed · 1 failed");
  await expect(page.locator("[data-receipt]")).toHaveClass(/notice-warn/);
  await expect(page.locator("[data-receipt]")).not.toHaveClass(/notice-ok/);
  await expect(list.getByRole("checkbox", { name: /restore-laptop/ })).toBeChecked();
  await expect(page.locator("[data-receipt]")).toContainText("PROPOSAL_STALE");
  await page.route(
    `**/api/proposals/${aligned.id}`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "FIXTURE_UNAVAILABLE", error: "Synthetic temporary read failure." }),
      }),
    { times: 1 },
  );
  await page.evaluate((id) => {
    location.hash = `#/proposals/${id}`;
  }, aligned.id);
  await expect(detail).toContainText("Synthetic temporary read failure");
  await detail.getByRole("button", { name: "Retry proposal" }).click();
  await expect(detail.getByRole("heading", { name: "review aligned", exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh queue", exact: true })).toBeEnabled();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(shots, "review-aligned-dark.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(detail).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(shots, "review-narrow.png"), fullPage: true, animations: "disabled" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const envelope = (await server.call(`/api/proposals/${aligned.id}`)).body;
  for (const [flag, unified, visible] of [
    ["redacted", "Sensitive source hidden.", "Sensitive values are hidden"],
    ["truncated", "@@ safe partial summary @@", "plain diff is shown"],
  ]) {
    await page.route(
      `**/api/proposals/${aligned.id}`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...envelope,
            data: {
              ...envelope.data,
              diff: { before: "PRIVATE-INCOMPLETE-SOURCE", after: "PRIVATE-INCOMPLETE-SOURCE", [flag]: true, unified },
            },
          }),
        }),
      { times: 1 },
    );
    await page.getByRole("button", { name: "Refresh queue", exact: true }).click();
    await expect(detail).toContainText(visible);
    await expect(detail.locator(".change-preview")).not.toContainText("PRIVATE-INCOMPLETE-SOURCE");
    await expect(page.getByRole("button", { name: "Refresh queue", exact: true })).toBeEnabled();
  }
  assert.deepEqual(errors, []);
  console.info(`Review screenshots: ${shots}`);
});
