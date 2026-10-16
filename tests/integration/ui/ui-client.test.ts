// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm ui` browser client (src/assets/ui): that every file is served and
 * embedded, that the page makes no off-host requests, that no markup reaches the
 * DOM except through the escaping `html` tag, and that each page module renders
 * real API data with hostile text escaped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createProposal } from "../../../src/commands/proposal/repository";
import { EMBEDDED_UI, startUiServer, type UiServer } from "../../../src/commands/ui/server";
import { resetConfigCache } from "../../../src/core/config/config";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { makeConfig } from "../../_helpers/factories";
import { git, makeGitRepo } from "../../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const UI_DIR = path.resolve(import.meta.dir, "../../../src/assets/ui");
const uiFiles = fs.readdirSync(UI_DIR).sort();
const jsFiles = uiFiles.filter((f) => f.endsWith(".js"));
const read = (name: string) => fs.readFileSync(path.join(UI_DIR, name), "utf8");

const CONTENT_TYPE: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

let storage: IsolatedAkmStorage;
let server: UiServer | undefined;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  storage.cleanup();
});

describe("static files", () => {
  test("every UI file is served from disk with the right content type, and nothing needs a token", async () => {
    server = await startUiServer({ port: 0 });
    const base = `http://${server.host}:${server.port}`;
    for (const file of uiFiles) {
      const response = await fetch(`${base}/${file}`);
      expect(response.status, file).toBe(200);
      expect(response.headers.get("content-type"), file).toContain(CONTENT_TYPE[path.extname(file)] as string);
      expect(await response.text(), file).toBe(read(file));
    }
    const root = await fetch(`${base}/`);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toBe(read("index.html"));
  });

  test("the embedded map holds exactly the files on disk, byte for byte", () => {
    expect(Object.keys(EMBEDDED_UI).sort()).toEqual(uiFiles);
    for (const file of uiFiles) expect(EMBEDDED_UI[file], file).toBe(read(file));
  });

  test("every relative import resolves to a file in the directory", () => {
    for (const file of jsFiles) {
      for (const match of read(file).matchAll(/(?:from\s+|import\()\s*["'](\.\/[^"']+)["']/g)) {
        expect(uiFiles, `${file} imports ${match[1]}`).toContain((match[1] as string).slice(2));
      }
    }
  });
});

describe("what the page may load and do", () => {
  test("index.html references only local assets and has no inline script or handler", () => {
    const html = read("index.html");
    const urls = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url, url).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(read("styles.css")).not.toMatch(/https?:\/\/|@import/i);
  });

  test("no client file makes an off-host request or evaluates strings", () => {
    for (const file of jsFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/["'`]https?:\/\//);
      expect(source, file).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|document\.write|insertAdjacentHTML|outerHTML/);
      expect(source, file).not.toMatch(/\son[a-z]+\s*=\s*["'\\]/i);
      expect(source, file).not.toMatch(/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/);
    }
  });

  test("the only markup write is mount() in lib.js, and it accepts nothing but the escaping html tag", () => {
    for (const file of jsFiles.filter((f) => f !== "lib.js")) expect(read(file), file).not.toContain("innerHTML");
    const lib = read("lib.js");
    // One assignment, preceded by the instanceof guard, whose value is the escaped text of a SafeHtml.
    expect(lib.match(/\.innerHTML\s*=/g)?.length).toBe(1);
    expect(lib).toMatch(/if \(!\(safe instanceof SafeHtml\)\) throw[^\n]*\n\s*element\.innerHTML = safe\.text;/);
    // `html` is the only producer of SafeHtml, and it escapes each interpolated value through part().
    expect(lib.match(/new SafeHtml\(/g)?.length).toBe(1);
    expect(lib).toMatch(/out \+= part\(values\[i\]\) \+ strings\[i \+ 1\]/);
    for (const file of jsFiles.filter((f) => f !== "lib.js")) {
      expect(read(file), file).not.toMatch(/SafeHtml|\.text\b\s*=/);
    }
  });

  test("external links are noopener and carry no unvetted scheme", () => {
    for (const file of jsFiles) {
      for (const match of read(file).matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
        expect(match[0], file).toContain("noopener");
      }
    }
    expect(read("markdown.js")).toContain("const SAFE_URL = /^(https?:\\/\\/|mailto:|#)/i;");
  });
});

// ---- client modules, run against the real server ---------------------------

type Rendered = { text: string };
type Ctx = { query: URLSearchParams; param: string; after: Array<(root: unknown) => void> };
type View = (ctx: Ctx) => Promise<Rendered>;

const load = (name: string) => import(path.join(UI_DIR, name)) as Promise<Record<string, unknown>>;
const view = async (file: string, fn = "render") => (await load(file))[fn] as View;
const ctx = (query = "", param = ""): Ctx => ({ query: new URLSearchParams(query), param, after: [] });

const PLANTED_API_KEY = "sk-client-test-literal-key-0001";
const HOSTILE_DESCRIPTION = "Deploy <b>guide</b>";
const GUIDE = `---\ndescription: ${HOSTILE_DESCRIPTION}\ntags: [deploy]\n---\n# Deploy <img src=x onerror=alert(1)>\n\nRun \`bun run deploy\` then <script>alert(1)</script>\n\n- one\n- [bad](javascript:alert(2))\n- [[knowledge/notes]]\n\n\`\`\`\n<i>code</i>\n\`\`\`\n`;
const LESSON =
  "---\ndescription: Use ripgrep\nwhen_to_use: Searching repos\n---\n\nPrefer rg over grep. <b>bold?</b>\n";

async function seed(): Promise<{ proposalId: string }> {
  const stash = storage.stashDir;
  fs.mkdirSync(path.join(stash, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(stash, "knowledge", "guide.md"), GUIDE);
  fs.writeFileSync(path.join(stash, "knowledge", "notes.md"), "---\ndescription: Notes\n---\nNotes\n");
  makeGitRepo({ dir: stash });
  git(stash, ["add", "knowledge"]);
  git(stash, ["commit", "-q", "-m", "akm improve auto-sync"]);
  writeSandboxConfig({
    ...makeConfig(stash),
    semanticSearchMode: "off",
    engines: {
      default: {
        kind: "llm",
        endpoint: "https://llm.example.test/v1/chat/completions",
        model: "m",
        apiKey: PLANTED_API_KEY,
      },
    },
  });
  resetConfigCache();
  await akmIndex({ stashDir: stash, full: true });

  const db = openStateDatabase();
  try {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const insert = db.prepare(
      "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("search", "deploy", null, null, null, "user", now);
    insert.run("show", null, "stash//knowledge/guide", null, null, "user", now);
    insert.run(
      "feedback",
      null,
      "stash//knowledge/guide",
      "positive",
      JSON.stringify({ reason: "<b>clear</b>" }),
      "user",
      now,
    );
    recordImproveRun(db, {
      id: "run-1",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      completedAt: new Date(Date.now() - 60_000).toISOString(),
      stashDir: stash,
      dryRun: false,
      strategy: "default",
      scopeMode: "all",
      scopeValue: null,
      guidance: null,
      ok: true,
      result: {
        schemaVersion: 2,
        ok: true,
        dryRun: false,
        plannedRefs: [],
        scope: { mode: "all" },
        memorySummary: { eligible: 0, derived: 0 },
        strategy: "default",
        triage: { promoted: 2, rejected: 1, deferred: 0, failed: 0, skippedByCap: 0 },
        sync: { committed: true, pushed: false, skipped: false },
        usageReport: {
          byProcessEngineModel: [{ process: "reflect", engine: "default", model: "m", calls: 3, failures: 1 }],
          noCalls: [],
        },
      } as never,
    });
  } finally {
    db.close();
  }
  const created = createProposal(stash, {
    ref: "lessons/rg",
    source: "reflect",
    sourceRun: "run-1",
    target: { source: "stash", root: stash },
    payload: { content: LESSON, frontmatter: { description: "Use ripgrep", when_to_use: "Searching repos" } },
  });
  return { proposalId: created.id };
}

describe("pages", () => {
  let realFetch: typeof fetch | undefined;
  const browserGlobals = ["location", "sessionStorage", "history"] as const;

  async function signIn(token: string): Promise<void> {
    const s = server as UiServer;
    const g = globalThis as Record<string, unknown>;
    g.location = { search: `?token=${token}`, pathname: "/", hash: "" };
    g.sessionStorage = { getItem: () => null, setItem: () => undefined };
    g.history = { replaceState: () => undefined };
    realFetch ??= globalThis.fetch;
    const target = realFetch;
    globalThis.fetch = ((input: string, init?: RequestInit) =>
      target(`http://${s.host}:${s.port}${input}`, init)) as typeof fetch;
    ((await load("lib.js")).initToken as () => void)();
  }

  afterEach(() => {
    if (realFetch) globalThis.fetch = realFetch;
    realFetch = undefined;
    for (const name of browserGlobals) delete (globalThis as Record<string, unknown>)[name];
  });

  test("overview, bundles, config, proposals, changes, search and asset render real data with hostile text escaped", async () => {
    const { proposalId } = await seed();
    server = await startUiServer({ port: 0 });
    await signIn(server.token);

    const overview = (await (await view("overview.js"))(ctx())).text;
    expect(overview).toContain("Overall health");
    expect(overview).toContain("Health checks");
    expect(overview).toContain("Recent improve runs");
    expect(overview).toContain("run-1");
    expect(overview).toContain('<svg class="chart"');
    expect(overview).toContain("Usage, last 14 days");

    const bundles = (await (await view("bundles.js"))(ctx())).text;
    expect(bundles).toContain("Configured bundles");
    expect(bundles).toContain("writable");
    expect(bundles).toContain("knowledge");

    const config = (await (await view("config.js"))(ctx())).text;
    expect(config).toContain("Effective config");
    expect(config).toContain("redacted");
    expect(config).not.toContain(PLANTED_API_KEY);

    const pending = (await (await view("proposals.js", "renderList"))(ctx())).text;
    expect(pending).toContain("stash//lessons/rg");
    expect(pending).toContain("reflect");
    const recent = (await (await view("proposals.js", "renderList"))(ctx("status=recent"))).text;
    expect(recent).toContain("No decided proposals yet.");
    const detail = (await (await view("proposals.js", "renderDetail"))(ctx("", proposalId))).text;
    expect(detail).toContain('<span class="dl add">');
    expect(detail).toContain("&lt;b&gt;bold?&lt;/b&gt;");
    expect(detail).not.toContain("<b>bold?</b>");

    const changes = (await (await view("changes.js"))(ctx())).text;
    expect(changes).toContain("akm improve auto-sync");
    expect(changes).toContain("improve-sync");

    const search = (await (await view("search.js"))(ctx("q=deploy"))).text;
    expect(search).toContain('href="#/asset?ref=');
    expect(search).toContain("Deploy &lt;b&gt;guide&lt;/b&gt;");
    expect(search).not.toContain("<b>guide</b>");

    const asset = (await (await view("asset.js"))(ctx("ref=knowledge%2Fguide"))).text;
    expect(asset).toContain("Frontmatter");
    expect(asset).toContain("&lt;b&gt;guide&lt;/b&gt;");
    expect(asset).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(asset).toContain("&lt;i&gt;code&lt;/i&gt;");
    expect(asset).toContain('href="#/asset?ref=knowledge%2Fnotes"');
    expect(asset).toContain("&lt;b&gt;clear&lt;/b&gt;");
    for (const unsafe of ["<script", "<img", "<b>", "<i>", 'href="javascript:']) {
      expect(asset, unsafe).not.toContain(unsafe);
    }
  });

  test("a missing asset and a wrong token surface as errors the app can show", async () => {
    await seed();
    server = await startUiServer({ port: 0 });
    await signIn(server.token);
    await expect((await view("asset.js"))(ctx("ref=knowledge%2Fnope"))).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
    });

    const lib = await load("lib.js");
    await signIn("not-the-token");
    const error = await ((lib.api as (path: string) => Promise<unknown>)("/api/meta") as Promise<unknown>).catch(
      (e) => e,
    );
    expect(error).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    const shown = (lib.errorState as (e: unknown) => Rendered)(error).text;
    expect(shown).toContain("Open the URL printed by <code>akm ui</code>");
  });
});

describe("helpers", () => {
  test("html escapes interpolated values, keeps nested html, and mount() refuses plain strings", async () => {
    const { html, esc, mount } = (await load("lib.js")) as {
      html: (s: TemplateStringsArray, ...v: unknown[]) => Rendered;
      esc: (v: unknown) => string;
      mount: (el: unknown, v: unknown) => void;
    };
    expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    const inner = html`<b>${"<i>"}</b>`;
    expect(html`<p title="${'"><script>'}">${inner}${[1, "<", null, false]}</p>`.text).toBe(
      '<p title="&quot;&gt;&lt;script&gt;"><b>&lt;i&gt;</b>1&lt;</p>',
    );
    expect(() => mount({}, "<b>x</b>")).toThrow(TypeError);
  });

  test("markdown renders its subset and drops unsafe links", async () => {
    const { markdown, splitFrontmatter } = (await load("markdown.js")) as {
      markdown: (s: string) => Rendered;
      splitFrontmatter: (s: string) => { fields: string[][]; body: string };
    };
    const out = markdown(
      "## Title <x>\n\n1. one\n2. two\n\n- a `c<d>`\n\n[ok](https://example.com) [no](javascript:alert(1)) **b**\n",
    ).text;
    expect(out).toContain("<h3>Title &lt;x&gt;</h3>");
    expect(out).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(out).toContain("<code>c&lt;d&gt;</code>");
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<strong>b</strong>");
    expect(splitFrontmatter("---\na: 1\nb: [x]\n---\nbody")).toEqual({
      fields: [
        ["a", "1"],
        ["b", "[x]"],
      ],
      body: "body",
    });
  });

  test("chart scales use round steps and the axis ends at or above the data", async () => {
    const { niceScale } = (await load("charts.js")) as { niceScale: (m: number) => { top: number; ticks: number[] } };
    expect(niceScale(0)).toEqual({ top: 1, ticks: [0, 1] });
    expect(niceScale(7)).toEqual({ top: 8, ticks: [0, 2, 4, 6, 8] });
    for (const max of [1, 3, 5, 9, 12, 26, 130, 4096]) {
      const { top, ticks } = niceScale(max);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(7);
      expect(ticks.at(-1)).toBe(top);
    }
  });
});
