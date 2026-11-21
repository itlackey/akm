// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { akm, launchFixture, open, pick } from "./support.mjs";

// The replay and the library mind map: responses in the wrong order, the three views of the map, choosing a tag, a
// library that is missing or empty, and a page that scrolls in one place only.
const tagged = (title, tags, body) =>
  `---\ntitle: ${title}\ndescription: Synthetic tagged reference\ntags: [${tags}]\n---\n# ${title}\n\n${body}\n`;

test("visualizations survive late responses, a changed library and a narrow window", {
  timeout: 240000,
}, async (t) => {
  // The fixture's assets carry only the tags the maintenance references have, so tag a few for a map with several leaves.
  const server = await launchFixture({
    metrics: true,
    similarity: true,
    configureFixture: async (fixture) => {
      const put = (file, text) => writeFile(path.join(fixture.root, "personal", file), text);
      await put(
        "knowledge/restore-laptop.md",
        tagged("Restore a laptop", "backup, recovery", "Verify the checksum before restoring a backup."),
      );
      await put("memories/backup-preference.md", tagged("Backup preference", "backup, preferences", "Keep one copy."));
      await put("knowledge/offsite-copy.md", tagged("Offsite copy", "backup, retention", "Keep a copy offsite."));
      await put("knowledge/retention-policy.md", tagged("Retention policy", "retention, recovery", "Keep for a year."));
      akm(fixture, ["index", "--full"]);
    },
  });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const fresh = async (setup) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup?.(page);
    return { page, errors };
  };
  const slider = (page) => page.getByRole("slider", { name: "Playhead" });
  const toEnd = (page) =>
    slider(page).evaluate((input) => {
      input.value = input.max;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  await t.test("Replay: an earlier period's late answer does not replace the later one", async () => {
    const { page, errors } = await fresh(async (page) => {
      // The first (24 hours) answer arrives after the 7-day one, and says something the real data does not.
      await page.route("**/api/events?since=24h", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.fulfill({
          json: {
            ok: true,
            data: {
              available: true,
              truncated: false,
              window: { since: new Date(Date.now() - 86_400_000).toISOString(), until: new Date().toISOString() },
              events: [
                {
                  id: 1,
                  at: new Date().toISOString(),
                  eventType: "search",
                  query: "stale period",
                  source: "user",
                  byPerson: true,
                  resultCount: 0,
                },
              ],
            },
          },
        });
      });
    });
    await open(page, server, "/activity/replay");
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    await page.waitForTimeout(3500);
    await toEnd(page);
    const replay = page.getByRole("region", { name: "Activity replay", exact: true });
    await expect(replay).toContainText("missing restore steps");
    await expect(replay).not.toContainText("stale period");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: the slider's end shows the events of the window's last minute", async () => {
    // A window that is not a whole number of minutes: the range input's last step falls short of its end.
    const until = Date.parse("2026-11-11T12:00:00.000Z");
    const since = until - 7 * 86_400_000 + 1;
    const { page, errors } = await fresh((page) =>
      page.route("**/api/events?since=7d", (route) =>
        route.fulfill({
          json: {
            ok: true,
            data: {
              available: true,
              truncated: false,
              window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
              events: [
                {
                  id: 1,
                  at: new Date(until - 30_000).toISOString(),
                  eventType: "search",
                  query: "last minute query",
                  source: "user",
                  byPerson: true,
                  resultCount: 0,
                },
              ],
            },
          },
        }),
      ),
    );
    await open(page, server, "/activity/replay");
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    await toEnd(page);
    await expect(page.getByRole("region", { name: "Activity replay", exact: true })).toContainText("last minute query");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "Replay: Play starts again from the beginning and moves the clock; the timeline moves the playhead",
    async () => {
      const { page, errors } = await fresh();
      await open(page, server, "/activity/replay");
      await expect(slider(page)).toBeVisible();
      const min = Number(await slider(page).getAttribute("min"));
      const max = Number(await slider(page).getAttribute("max"));
      // The replay opens at the end, so the button offers to play from the start.
      const before = Number(await slider(page).inputValue());
      await page.getByRole("combobox", { name: "Speed" }).selectOption({ label: "Fast (4×)" });
      await page.getByRole("button", { name: "Play from start", exact: true }).click();
      await expect.poll(async () => Number(await slider(page).inputValue())).toBeLessThan(before);
      const first = Number(await slider(page).inputValue());
      await expect.poll(async () => Number(await slider(page).inputValue())).toBeGreaterThan(first);
      // Clicking the timeline seeks and pauses.
      const timeline = page.locator(".timeline svg");
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      const box = await timeline.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
      const middle = Number(await slider(page).inputValue());
      assert.ok(Math.abs(middle - (min + max) / 2) < (max - min) * 0.05, `playhead ${middle} is not mid-window`);
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test("Replay: it opens at the end with full figures, and a new period reads only the events", async () => {
    const { page, errors } = await fresh();
    const requests = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/graph" || url.pathname === "/api/events") requests.push(url.pathname + url.search);
    });
    await open(page, server, "/activity/replay");
    await expect(slider(page)).toBeVisible();
    // Opens at the end of the period: the slider is on its last step (a window that is not whole minutes stops short
    // of its maximum, and scrubTime reads that step as the end) and the totals are full.
    await expect
      .poll(async () => Number(await slider(page).getAttribute("max")) - Number(await slider(page).inputValue()))
      .toBeLessThan(60_000);
    const replay = page.getByRole("region", { name: "Activity replay", exact: true });
    for (const figure of [
      "events",
      "reads",
      "searches",
      "curates",
      "found nothing",
      "negative feedback",
      "assets used",
    ])
      await expect(replay.getByText(figure, { exact: true })).toBeVisible();
    for (const list of ["Searched for, not found", "Most used so far", "Feedback given so far", "Latest events"])
      await expect(replay.getByRole("heading", { name: list })).toBeVisible();
    await expect(replay.getByRole("button", { name: /^Play/ })).toHaveAttribute(
      "title",
      /Plays the whole period in about 1 minute/,
    );
    await expect(replay).toContainText("Tallest bar =");
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    await toEnd(page);
    await page.getByRole("button", { name: /^Play/ }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    assert.equal(requests.filter((r) => r.startsWith("/api/graph")).length, 1, requests.join(" "));
    assert.deepEqual(
      requests.filter((r) => r.startsWith("/api/events")),
      ["/api/events?since=24h", "/api/events?since=7d"],
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: a graph that is not available shows its note, not an empty map", async () => {
    const { page, errors } = await fresh((page) =>
      page.route("**/api/graph", (route) =>
        route.fulfill({ json: { ok: true, data: { available: false, note: "Synthetic: no index here." } } }),
      ),
    );
    await open(page, server, "/activity/replay");
    await expect(page.getByText("Synthetic: no index here.")).toBeVisible();
    await expect(page.getByText("assets used")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Play/ })).toBeDisabled();
    assert.deepEqual(errors, []);
    await page.close();
  });

  // A library the page is given instead of the fixture's: two asset types carrying tags (some of them not subjects),
  // one link, and one of each problem.
  const day = 86_400_000;
  const ago = (days) => new Date(Date.now() - days * day).toISOString();
  const mapPayload = {
    available: true,
    note: "Synthetic library.",
    types: ["knowledge", "memory"],
    bundles: ["wiki", "notes"],
    beliefs: ["superseded"],
    use: { since: ago(90), source: "user" },
    kinds: ["xref"],
    nodes: {
      ref: [
        "wiki//knowledge/deploy/a",
        "wiki//knowledge/deploy/b",
        "notes//memories/deploy/c",
        "wiki//knowledge/auth/d",
        "notes//memories/auth/e",
        "notes//memories/auth/f",
        "notes//memories/misc/g",
      ],
      type: [0, 0, 1, 0, 1, 1, 1],
      bundle: [0, 0, 1, 0, 1, 1, 1],
      belief: [-1, 0, -1, -1, -1, -1, -1],
      shows: [9, 0, 2, 0, 0, 1, 0],
      lastShownAt: [ago(2), null, ago(60), null, null, ago(10), null],
      modifiedAt: [ago(5), ago(400), ago(30), ago(20), ago(500), ago(1), ago(900)],
      positive: [1, 0, 0, 0, 0, 0, 0],
      negative: [0, 0, 0, 2, 0, 0, 0],
      // deploy, auth, rollout; skill, creating, 2026, example.com and a1b2c3d4 name no subject and are not drawn.
      tags: [[0, 2, 3, 4, 5], [0, 2, 6], [0, 7], [1], [1], [1, 3], []],
    },
    links: { from: [0, 2], to: [1, 3], kind: [0, 0] },
    tags: ["deploy", "auth", "rollout", "skill", "creating", "2026", "example.com", "a1b2c3d4"],
    duplicates: { threshold: 0.96, a: [3], b: [5], cosine: [0.98], truncated: false },
  };
  const withGraph = (page, payload = mapPayload) =>
    page.route("**/api/graph", (route) => route.fulfill({ json: { ok: true, data: payload } }));
  const tab = (page, name) => page.getByRole("tab", { name, exact: true });
  const figures = (page) => page.getByRole("complementary", { name: "Figures" });
  const mapButton = (page, name) => page.locator(".mind-map").getByRole("button", { name, exact: true });
  const consoleErrors = (page, errors) =>
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  /** Elements inside `selector` that scroll on their own: more than one scroller means a page you scroll twice. */
  const innerScrollers = (page, selector) =>
    page.evaluate((root) => {
      const top = document.querySelector(root);
      return [top, ...top.querySelectorAll("*")]
        .filter((el) => {
          const style = getComputedStyle(el);
          return /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
    }, selector);

  const sideHeading = (page) => figures(page).getByRole("heading", { level: 2 });

  await t.test(
    "Library map: each question draws its tags and offers its own filters, with what each finds",
    async () => {
      const { page, errors } = await fresh((page) => withGraph(page));
      await open(page, server, "/library/map");
      const filters = page.locator(".show-menu");
      const offered = () => filters.locator("label").allTextContents();
      // Contents: the largest tags; a filter per asset type, the unlinked, and what two bundles repeat. None is on.
      await expect(tab(page, "Contents")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Contents")).toHaveAttribute("title", "What is in the library?");
      await expect(mapButton(page, "Knowledge: 3")).toBeVisible();
      await expect(mapButton(page, "Memories and facts: 4")).toBeVisible();
      await expect(mapButton(page, "auth (Memories and facts): 2")).toBeVisible();
      await expect(mapButton(page, "rollout (Knowledge): 2")).toBeVisible();
      // Tags that name no subject are not drawn.
      await expect(
        page.locator(".mind-map").getByRole("button", { name: /^(skill|creating|2026|example\.com)/ }),
      ).toHaveCount(0);
      assert.deepEqual(await offered(), [
        "Knowledge3",
        "Memories and facts4",
        "Not linked to anything3",
        "Repeated across bundles1",
      ]);
      await expect(filters.locator("label:has(input:checked)")).toHaveCount(0);
      await expect(figures(page)).toHaveCount(0);
      // A filter lists exactly what it finds, most read first, each asset a link to its page.
      await pick(page, "Not linked to anything");
      await expect(figures(page).getByRole("heading", { level: 3 })).toHaveText("Not linked to anything3");
      await expect(figures(page).locator(".read-row")).toHaveText([
        "memories/auth/f1 read",
        "memories/auth/e0 reads",
        "memories/misc/g0 reads",
      ]);
      await expect(figures(page).locator(".read-row a").first()).toHaveAttribute("href", /\/library\/search\?ref=/);
      // Use: the most read tags with their reads; it opens on what to retire, the longest untouched first.
      await tab(page, "Use").click();
      await expect(mapButton(page, "Knowledge: 9 reads")).toBeVisible();
      await expect(mapButton(page, "deploy (Memories and facts): 2 reads")).toBeVisible();
      // Knowledge's auth asset was never read, so the tag is not among the most read.
      await expect(page.locator(".mind-map").getByRole("button", { name: /^auth \(Knowledge\)/ })).toHaveCount(0);
      assert.deepEqual(await offered(), ["Not read, untouched 6+ months3", "Read but disliked0", "Most read3"]);
      await expect(filters.locator("label:has(input:checked)")).toHaveText("Not read, untouched 6+ months3");
      // The one disliked asset is never read, so that filter finds nothing and cannot be chosen.
      await expect(filters.locator("label", { hasText: "Read but disliked" }).locator("input")).toBeDisabled();
      await expect(figures(page).locator(".read-row")).toHaveText([
        "memories/misc/guntouched 2 years",
        "memories/auth/euntouched 16 months",
        "knowledge/deploy/buntouched 13 months",
      ]);
      await pick(page, "Most read");
      await expect(figures(page).locator(".read-row").first()).toHaveText("knowledge/deploy/a9 reads");
      // Problems: the tags with problem assets; it opens on the first kind of problem there is.
      await tab(page, "Problems").click();
      await expect(mapButton(page, "Knowledge: 2 problems")).toBeVisible();
      await expect(mapButton(page, "auth (Memories and facts): 1 problem")).toBeVisible();
      await expect(
        page.locator(".mind-map").getByRole("button", { name: /^deploy \(Memories and facts\)/ }),
      ).toHaveCount(0);
      assert.deepEqual(await offered(), [
        "Outdated, still read0",
        "Near-identical pairs1",
        "Disliked1",
        "Outdated, unread1",
      ]);
      await expect(filters.locator("label:has(input:checked)")).toHaveText("Near-identical pairs1");
      await expect(figures(page).locator(".pairs li")).toContainText("98% alike");
      await expect(figures(page).getByRole("link", { name: "Compare" })).toHaveAttribute("href", /compare=.*compare=/);
      await pick(page, "Outdated, unread");
      await expect(figures(page).locator(".read-row")).toHaveText(["knowledge/deploy/bsuperseded"]);
      // Choosing the filter that is on turns it off, and the column goes with it.
      await pick(page, "Outdated, unread");
      await expect(figures(page)).toHaveCount(0);
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test(
    "Library map: choosing a tag scopes the filters to it and draws what joins it; Escape closes it",
    async () => {
      const { page, errors } = await fresh((page) => withGraph(page));
      await open(page, server, "/library/map");
      const filters = page.locator(".show-menu");
      await mapButton(page, "auth (Knowledge): 1").click();
      await expect(mapButton(page, "auth (Knowledge): 1")).toHaveAttribute("aria-pressed", "true");
      await expect(sideHeading(page)).toHaveText("auth");
      await expect(figures(page)).toContainText("Tag in Knowledge · 1 asset");
      // The filters count the tag's assets only, and say so beside them.
      await expect(page.getByRole("button", { name: "In auth" })).toBeVisible();
      await expect(filters.locator("label", { hasText: "Knowledge" })).toHaveText("Knowledge1");
      await expect(figures(page).locator(".read-row")).toHaveText(["knowledge/auth/d1 link"]);
      // c links to d, and d nearly duplicates f: two groups, two lines.
      await expect(page.locator(".mind-map .relations path")).toHaveCount(2);
      const joined = figures(page).locator("section", { hasText: "Linked to these types and tags" });
      await expect(joined).toContainText("auth · Memories and facts 1 near-identical pair");
      await expect(joined).toContainText("deploy · Memories and facts 1 link");
      // A joined group in the column is chosen in turn.
      await joined.getByRole("button", { name: "auth · Memories and facts" }).click();
      await expect(sideHeading(page)).toHaveText("auth");
      await expect(figures(page)).toContainText("Tag in Memories and facts");
      // The scope is cleared from beside the filters, or with Escape.
      await page.getByRole("button", { name: "In auth" }).click();
      await expect(sideHeading(page)).toHaveCount(0);
      await mapButton(page, "auth (Knowledge): 1").click();
      await page.keyboard.press("Escape");
      await expect(sideHeading(page)).toHaveCount(0);
      await expect(page.locator(".mind-map .relations path")).toHaveCount(0);
      // One bundle: the map and the filters follow it.
      await page.getByRole("combobox", { name: /^Bundle/ }).selectOption({ label: "notes" });
      await expect(page.locator(".mind-map").getByRole("button", { name: /^Knowledge/ })).toHaveCount(0);
      await expect(filters.locator("label", { hasText: "Memories and facts" })).toHaveText("Memories and facts4");
      await expect(filters.locator("label", { hasText: "Knowledge" })).toHaveCount(0);
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test(
    "Library map: an index with groups draws them as points, names them, and Tags draws the tags",
    async () => {
      const { page, errors } = await fresh((page) =>
        withGraph(page, {
          ...mapPayload,
          groups: {
            count: 2,
            group: [0, 0, 0, 1, 1, 1, -1],
            x: [0, 2, -2, 50, 52, 48, 0],
            y: [0, 1, -1, 0, 1, -1, 0],
            z: [0, 0, 0, 10, 10, 10, 0],
          },
        }),
      );
      consoleErrors(page, errors);
      await open(page, server, "/library/map");
      const drawing = page.getByRole("group", { name: "Drawing" });
      // The plane first: it is read faster than 3D, which is one choice away.
      await expect(drawing.getByRole("button", { name: "2D" })).toHaveAttribute("aria-pressed", "true");
      const named = figures(page).locator("section", { hasText: "Groups by meaning" });
      await expect(named.getByRole("button")).toHaveText(["deploy · rollout", "auth"]);
      await named.getByRole("button", { name: "auth" }).click();
      await expect(sideHeading(page)).toHaveText("auth");
      await expect(figures(page)).toContainText("Group by meaning");
      await figures(page).getByRole("button", { name: "Close", exact: true }).click();
      await drawing.getByRole("button", { name: "Tags" }).click();
      await expect(mapButton(page, "Knowledge: 3")).toBeVisible();
      await expect(named).toHaveCount(0);
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  await t.test("Library map: the wheel over the 3D map, even over a group's name, never scrolls the page", async () => {
    const { page } = await fresh((page) =>
      withGraph(page, {
        ...mapPayload,
        groups: {
          count: 2,
          group: [0, 0, 0, 1, 1, 1, -1],
          x: [0, 2, -2, 50, 52, 48, 0],
          y: [0, 1, -1, 0, 1, -1, 0],
          z: [0, 0, 0, 10, 10, 10, 0],
        },
      }),
    );
    await open(page, server, "/library/map");
    // A name clear of the tools drawn over the map's top edge, which are not the map.
    const name = page.locator(".group-name").last();
    await expect(name).toBeVisible();
    // The map fills the window, so the page is made taller than it: a wheel that leaked would then scroll it.
    await page.addStyleTag({ content: "body { min-block-size: 200vh; }" });
    const before = await page.evaluate(() => scrollY);
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 300), "page can scroll");
    const box = await name.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => scrollY), before);
    await page.close();
  });

  await t.test("Library map: finding by name or tag narrows the map and its filters, with a count", async () => {
    const { page } = await fresh((page) => withGraph(page));
    await open(page, server, "/library/map");
    await tab(page, "Use").click();
    await page.getByRole("group", { name: "Drawing" }).getByRole("button", { name: "Tags" }).click();
    const filter = page.getByRole("searchbox", { name: "Filter" });
    const retire = page
      .getByRole("group", { name: "Show on the map" })
      .getByRole("button", { name: /^Not read, untouched/ });
    await expect(retire).toHaveText("Not read, untouched 6+ months3");
    await filter.fill("auth");
    await expect(page.getByText("3 of 7 assets")).toBeVisible();
    await expect(retire).toHaveText("Not read, untouched 6+ months1");
    await expect(page.locator(".mind-map").getByRole("button", { name: /^deploy/ })).toHaveCount(0);
    await filter.fill("");
    await expect(page.getByText("3 of 7 assets")).toHaveCount(0);
    await expect(retire).toHaveText("Not read, untouched 6+ months3");
    await page.close();
  });

  await t.test("Library map: on the points, finding by name fades the names of groups with no match", async () => {
    const { page } = await fresh((page) =>
      withGraph(page, {
        ...mapPayload,
        groups: {
          count: 2,
          group: [0, 0, 0, 1, 1, 1, -1],
          x: [0, 2, -2, 50, 52, 48, 0],
          y: [0, 1, -1, 0, 1, -1, 0],
          z: [0, 0, 0, 10, 10, 10, 0],
        },
      }),
    );
    await open(page, server, "/library/map");
    const opacity = (label) => page.locator(".group-name", { hasText: label }).evaluate((el) => el.style.opacity);
    await expect.poll(() => opacity("auth")).toBe("1");
    await page.getByRole("searchbox", { name: "Filter" }).fill("auth");
    await expect.poll(() => opacity("deploy")).toBe("0.3");
    assert.equal(await opacity("auth"), "1");
    await page.getByRole("searchbox", { name: "Filter" }).fill("");
    await expect.poll(() => opacity("deploy")).toBe("1");
    await page.close();
  });

  await t.test("Files editor: it uses the pane's width and scrolls in one place", async () => {
    const { page } = await fresh();
    await open(page, server, `/library/edit?${new URLSearchParams({ ref: server.refs.document })}`);
    const editor = page.getByRole("textbox", { name: /^Markdown (body|source, including optional frontmatter)$/ });
    const long = Array.from({ length: 150 }, (_, n) => `Line ${n} of a long note`).join("\n");
    // With the properties above the body, the body grows and the pane is the one place that scrolls.
    await editor.fill(long);
    assert.deepEqual(
      (await innerScrollers(page, ".files-content")).map((s) => s.split(" ")[0]),
      ["div.files-content"],
    );
    // The editor and the findings beside it fill the pane.
    assert.ok((await page.locator(".editor-columns").boundingBox()).width > 800, "the editor fills the pane");
    // In Text the box takes the pane's height and scrolls its own text.
    await page.getByRole("button", { name: "Text", exact: true }).click();
    await editor.fill(long);
    assert.deepEqual(
      (await innerScrollers(page, ".files-content")).map((s) => s.split(" ")[0]),
      ["textarea.source-editor"],
    );
    await page.close();
  });

  await t.test("Library map: ?select= opens that asset's tag, and an unknown asset is named", async () => {
    const { page } = await fresh((page) => withGraph(page));
    await open(page, server, `/library/map?select=${encodeURIComponent("notes//memories/auth/e")}`);
    await expect(sideHeading(page)).toHaveText("auth");
    await expect(mapButton(page, "auth (Memories and facts): 2")).toHaveAttribute("aria-pressed", "true");
    await page.goto(`${server.origin}/library/map?select=${encodeURIComponent("wiki//knowledge/missing")}`);
    await expect(page.getByText("No asset “wiki//knowledge/missing” is in the library.")).toBeVisible();
    await page.close();
  });

  await t.test("Library map: the fixture library draws its tags, with no errors and one scroller", async () => {
    const { page, errors } = await fresh();
    consoleErrors(page, errors);
    await open(page, server, "/library/map");
    // The tagged knowledge assets: recovery on the restore guide and the policy, retention on the policy and the copy note.
    await expect(mapButton(page, "recovery (Knowledge): 2")).toBeVisible();
    await expect(mapButton(page, "retention (Knowledge): 2")).toBeVisible();
    assert.ok((await page.locator(".mind-map").getByRole("button").count()) >= 5);
    assert.deepEqual(await innerScrollers(page, ".map-page"), []);
    for (const name of ["Use", "Problems", "Contents"]) {
      await tab(page, name).click();
      assert.deepEqual(await innerScrollers(page, ".map-page"), [], name);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test(
    "Library map: no index, an empty library and a failed read each say so, and Retry recovers",
    async () => {
      const empty = {
        ...mapPayload,
        note: "0 assets.",
        types: [],
        bundles: [],
        beliefs: [],
        use: null,
        kinds: [],
        nodes: Object.fromEntries(Object.keys(mapPayload.nodes).map((column) => [column, []])),
        links: { from: [], to: [], kind: [] },
        tags: [],
        duplicates: null,
      };
      {
        const { page, errors } = await fresh((page) =>
          withGraph(page, { ...empty, available: false, note: "The index could not be read." }),
        );
        await open(page, server, "/library/map");
        await expect(page.getByText("The index could not be read.")).toBeVisible();
        await expect(page.getByText("Reading the library")).toHaveCount(0);
        assert.deepEqual(errors, []);
        await page.close();
      }
      {
        const { page, errors } = await fresh((page) => withGraph(page, empty));
        await open(page, server, "/library/map");
        await expect(page.getByRole("status").filter({ hasText: "No assets in All bundles." })).toBeVisible();
        for (const name of ["Use", "Problems", "Contents"]) await tab(page, name).click();
        assert.deepEqual(errors, []);
        await page.close();
      }
      {
        let fail = true;
        const { page } = await fresh((page) =>
          page.route("**/api/graph", (route) =>
            fail
              ? route.fulfill({ status: 500, json: { ok: false, error: "Synthetic: the graph failed." } })
              : route.fulfill({ json: { ok: true, data: mapPayload } }),
          ),
        );
        await open(page, server, "/library/map");
        await expect(page.getByRole("alert")).toContainText("Synthetic: the graph failed.");
        fail = false;
        await page.getByRole("button", { name: "Retry" }).click();
        await expect(mapButton(page, "Knowledge: 3")).toBeVisible();
        await expect(page.getByRole("alert")).toHaveCount(0);
        await page.close();
      }
    },
  );

  await t.test(
    "Library map: at phone width the page does not scroll sideways and the map stays inside it",
    async () => {
      const { page, errors } = await fresh(async (page) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await withGraph(page);
      });
      await open(page, server, "/library/map");
      await expect(tab(page, "Problems")).toBeVisible();
      await expect(mapButton(page, "Knowledge: 3")).toBeVisible();
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(sideways <= 1, `the page scrolls ${sideways}px sideways`);
      const map = await page.locator(".mind-map").boundingBox();
      assert.ok(
        map && map.x >= 0 && map.x + map.width <= 391,
        `the map spans ${map?.x} to ${map && map.x + map.width}`,
      );
      assert.deepEqual(errors, []);
      await page.close();
    },
  );

  // The replay's mind map counts the events on the assets the period touched: reads on e, f and a, and a search that
  // hit a (part of its search, not an event of its own).
  await t.test("Replay: the map counts events on each type and tag up to the playhead", async () => {
    const hours = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
    const { page, errors } = await fresh(async (page) => {
      await withGraph(page);
      await page.route("**/api/events?since=24h", (route) =>
        route.fulfill({
          json: {
            ok: true,
            data: {
              available: true,
              truncated: false,
              window: { since: hours(24), until: hours(0) },
              events: [
                {
                  id: 1,
                  at: hours(3),
                  eventType: "show",
                  ref: "notes//memories/auth/e",
                  source: "user",
                  byPerson: true,
                },
                {
                  id: 2,
                  at: hours(2),
                  eventType: "show",
                  ref: "notes//memories/auth/f",
                  source: "user",
                  byPerson: true,
                },
                {
                  id: 3,
                  at: hours(1.5),
                  eventType: "search",
                  ref: "wiki//knowledge/deploy/a",
                  query: "ship",
                  source: "user",
                  byPerson: true,
                },
                {
                  id: 4,
                  at: hours(1),
                  eventType: "show",
                  ref: "wiki//knowledge/deploy/a",
                  source: "user",
                  byPerson: true,
                },
              ],
            },
          },
        }),
      );
    });
    consoleErrors(page, errors);
    await open(page, server, "/activity/replay");
    const replay = page.getByRole("region", { name: "Activity replay", exact: true });
    await expect(mapButton(page, "auth (Memories and facts): 2 events")).toBeVisible();
    await expect(mapButton(page, "deploy (Knowledge): 1 event")).toBeVisible();
    await expect(replay.locator(".root")).toContainText("3 events");
    await expect(replay).toContainText("read notes//memories/auth/e");
    await mapButton(page, "auth (Memories and facts): 2 events").click();
    await expect(mapButton(page, "auth (Memories and facts): 2 events")).toHaveAttribute("aria-pressed", "true");
    // At the start of the period nothing has happened yet.
    await slider(page).evaluate((input) => {
      input.value = input.min;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // A type or tag is drawn once it has had an event, and not before.
    await expect(page.locator(".mind-map").getByRole("button", { name: /^auth \(Memories and facts\)/ })).toHaveCount(
      0,
    );
    await expect(replay.locator(".root")).not.toContainText("3 events");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test("Replay: the fixture's events draw with no console errors and one scroller", async () => {
    const { page, errors } = await fresh();
    consoleErrors(page, errors);
    await open(page, server, "/activity/replay");
    await expect(slider(page)).toBeVisible();
    await expect(mapButton(page, "recovery (Knowledge): 2 events")).toBeVisible();
    assert.deepEqual(await innerScrollers(page, ".replay"), []);
    await page.getByRole("combobox", { name: "Period" }).selectOption("7d");
    await expect(slider(page)).toBeVisible();
    assert.deepEqual(await innerScrollers(page, ".replay"), []);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
