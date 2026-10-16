// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm ui` server and API against a real sandbox stash (integration: opens
 * state.db and index.db, binds a socket and runs git).
 *
 * What it pins: the token and Host guards, the shape of every endpoint, that
 * search matches `akmSearch`, that no response carries a planted secret, and
 * that a browse session leaves both databases byte-for-byte as they were.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createProposal } from "../../../src/commands/proposal/repository";
import { akmSearch } from "../../../src/commands/read/search";
import { startUiServer, type UiServer } from "../../../src/commands/ui/server";
import { resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { runCliCapture } from "../../_helpers/cli";
import { makeConfig } from "../../_helpers/factories";
import { git, makeGitRepo } from "../../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const PLANTED_API_KEY = "sk-planted-literal-api-key-0001";
const PLANTED_CONFIG_TOKEN = "tok-planted-config-token-0002";
const PLANTED_URL_TOKEN = "tok-planted-url-query-0003";
const PLANTED_SECRET_FILE = "planted-secret-file-value-0004";
const PLANTED_ENV_VALUE = "planted-env-file-value-0005";
const PLANTED = [PLANTED_API_KEY, PLANTED_CONFIG_TOKEN, PLANTED_URL_TOKEN, PLANTED_SECRET_FILE, PLANTED_ENV_VALUE];

const GUIDE = "---\ndescription: Deploy guide\n---\n# Deploy guide\nRun the deploy script. See [[knowledge/notes]].\n";
const NOTES = "---\ndescription: Deploy notes\n---\n# Notes\nMore deploy detail.\n";
const LESSON = "---\ndescription: Use ripgrep\nwhen_to_use: Searching repos\n---\n\nPrefer rg over grep.\n";

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

function sha1(file: string): string {
  return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

/** A stash with indexed knowledge, planted secrets, a git history, usage, feedback and one improve run. */
async function seed(): Promise<void> {
  const stash = storage.stashDir;
  fs.mkdirSync(path.join(stash, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(stash, "env"), { recursive: true });
  fs.mkdirSync(path.join(stash, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(stash, "knowledge", "guide.md"), GUIDE);
  fs.writeFileSync(path.join(stash, "knowledge", "notes.md"), NOTES);
  fs.writeFileSync(path.join(stash, "env", "prod.env"), `API_TOKEN=${PLANTED_ENV_VALUE}\n`);
  fs.writeFileSync(path.join(stash, "secrets", "deploy-key"), PLANTED_SECRET_FILE);

  makeGitRepo({ dir: stash });
  git(stash, ["add", "knowledge"]);
  git(stash, ["commit", "-q", "-m", "akm improve auto-sync"]);
  fs.writeFileSync(path.join(stash, "knowledge", "later.md"), "# later\n");
  git(stash, ["add", "knowledge"]);
  git(stash, ["commit", "-q", "-m", "akm accept: reflect abcd1234 stash//knowledge/later"]);
  fs.writeFileSync(path.join(stash, "knowledge", "more.md"), "# more\n");
  git(stash, ["add", "knowledge"]);
  git(stash, ["commit", "-q", "-m", "akm save 2026-10-16 10:00:00"]);

  writeSandboxConfig({
    ...makeConfig(stash),
    semanticSearchMode: "off",
    engines: {
      default: {
        kind: "llm",
        endpoint: `https://llm.example.test/v1/chat/completions?token=${PLANTED_URL_TOKEN}`,
        model: "chat-model",
        apiKey: PLANTED_API_KEY,
      },
    },
    someToken: PLANTED_CONFIG_TOKEN,
  });
  resetConfigCache();
  await akmIndex({ stashDir: stash, full: true });

  const db = openStateDatabase();
  try {
    const insert = db.prepare(
      "INSERT INTO usage_events (event_type, query, entry_ref, signal, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    insert.run("search", "deploy", null, null, null, "user", now);
    insert.run("show", null, "stash//knowledge/guide", null, null, "user", now);
    insert.run("search", "ignored", null, null, null, "improve", now);
    insert.run(
      "feedback",
      null,
      "stash//knowledge/guide",
      "positive",
      JSON.stringify({ reason: "clear" }),
      "user",
      now,
    );
    insert.run("feedback", null, "stash//knowledge/guide", "negative", null, "user", now);
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
        preRunSync: { committed: false, pushed: false, skipped: true, reason: "no remote" },
        usageReport: {
          byProcessEngineModel: [
            { process: "reflect", engine: "default", model: "chat-model", calls: 3, failures: 1 },
            { process: "triage.judgment", engine: "default", model: "chat-model", calls: 2, failures: 0 },
          ],
          noCalls: [],
        },
      } as never,
    });
  } finally {
    db.close();
  }
}

async function start(): Promise<UiServer> {
  server = await startUiServer({ port: 0 });
  return server;
}

function api(s: UiServer, pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://${s.host}:${s.port}${pathAndQuery}`, {
    ...init,
    headers: { "X-Akm-Ui-Token": s.token, ...(init.headers as Record<string, string> | undefined) },
  });
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted field by field in each test
type Json = Record<string, any>;

async function data<T = Json>(s: UiServer, pathAndQuery: string): Promise<T> {
  const response = await api(s, pathAndQuery);
  const body = (await response.json()) as { ok: boolean; data?: T; error?: string };
  expect(body.error).toBeUndefined();
  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
  return body.data as T;
}

/** Raw request with an explicit Host header, which `fetch` does not let a caller set. */
function requestWithHost(
  s: UiServer,
  hostHeader: string,
  requestPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: s.host, port: s.port, path: requestPath, headers: { Host: hostHeader, "X-Akm-Ui-Token": s.token } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("server and guards", () => {
  test("starts on a random port, serves the placeholder UI without a token, and embeds no data", async () => {
    await seed();
    const s = await start();
    expect(s.port).toBeGreaterThan(0);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/?token=${s.token}`);

    const index = await fetch(`http://${s.host}:${s.port}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await index.text();
    expect(html).toContain("<title>akm ui</title>");
    expect(html).not.toContain(s.token);

    const js = await fetch(`http://${s.host}:${s.port}/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    const css = await fetch(`http://${s.host}:${s.port}/styles.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await fetch(`http://${s.host}:${s.port}/nope.js`)).status).toBe(404);
    expect((await fetch(`http://${s.host}:${s.port}/..%2f..%2fpackage.json`)).status).toBe(404);
  });

  test("an API request without the token, or with a wrong one, gets a 401 JSON error", async () => {
    await seed();
    const s = await start();
    for (const init of [{}, { headers: { "X-Akm-Ui-Token": "wrong" } }]) {
      const response = await fetch(`http://${s.host}:${s.port}/api/meta`, init);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    }
    expect((await fetch(`http://${s.host}:${s.port}/api/meta?token=wrong`)).status).toBe(401);
    // The token is accepted as a header or as a query parameter.
    expect((await api(s, "/api/meta")).status).toBe(200);
    expect((await fetch(`http://${s.host}:${s.port}/api/meta?token=${s.token}`)).status).toBe(200);
  });

  test("only GET is accepted: a non-GET needs the token, then is refused", async () => {
    await seed();
    const s = await start();
    const bare = await fetch(`http://${s.host}:${s.port}/`, { method: "POST" });
    expect(bare.status).toBe(401);
    const withToken = await api(s, "/api/meta", { method: "POST" });
    expect(withToken.status).toBe(405);
    expect(await withToken.json()).toMatchObject({ ok: false, code: "METHOD_NOT_ALLOWED" });
  });

  test("a Host header other than the bound address is refused (DNS rebinding guard)", async () => {
    await seed();
    const s = await start();
    expect((await requestWithHost(s, `127.0.0.1:${s.port}`, "/api/meta")).status).toBe(200);
    for (const bad of ["evil.example.com", `evil.example.com:${s.port}`, `127.0.0.1:${s.port + 1}`, "localhost"]) {
      const refused = await requestWithHost(s, bad, "/api/meta");
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.body)).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
    }
    expect((await requestWithHost(s, "evil.example.com", "/")).status).toBe(403);
  });

  test("an unknown API route is a 404 JSON error and close() frees the port", async () => {
    await seed();
    const s = await start();
    const response = await api(s, "/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: "NOT_FOUND" });
    await s.close();
    server = undefined;
    await expect(fetch(`http://${s.host}:${s.port}/api/meta`)).rejects.toBeDefined();
  });
});

describe("endpoints", () => {
  test("GET /api/meta", async () => {
    await seed();
    const s = await start();
    const meta = await data(s, "/api/meta");
    expect(meta).toMatchObject({ readOnly: true, host: "127.0.0.1", port: s.port, stashDir: storage.stashDir });
    expect(typeof meta.version).toBe("string");
    expect(meta.stateDbPath).toBe(getStateDbPath());
    expect(Date.parse(meta.startedAt)).not.toBeNaN();
  });

  test("GET /api/overview: health, metrics, last improve runs and 14 days of user usage", async () => {
    await seed();
    const s = await start();
    const overview = await data(s, "/api/overview");
    expect(overview.errors).toBeUndefined();
    expect(overview.health.hardChecks.length).toBeGreaterThan(0);
    expect(overview.health.report).toMatchObject({ window: "24h", compare: "24h" });
    expect(overview.health.windows).toHaveLength(2);
    // The round-trip probe writes a row; a read-only run reports it skipped.
    const roundTrip = overview.health.hardChecks.find((c: { name: string }) => c.name === "state-db-round-trip");
    expect(roundTrip.message).toContain("skipped");
    expect(overview.metrics.schemaVersion).toBeDefined();

    expect(overview.improveRuns).toHaveLength(1);
    expect(overview.improveRuns[0]).toMatchObject({
      id: "run-1",
      ok: true,
      strategy: "default",
      triage: { promoted: 2, rejected: 1 },
      sync: { committed: true },
      preRunSync: { skipped: true },
      modelCalls: { total: 5, failures: 1, byProcess: { reflect: { calls: 3, failures: 1 } } },
    });
    expect(overview.improveRuns[0].durationMs).toBeGreaterThan(0);

    expect(overview.usageByDay).toHaveLength(14);
    const today = overview.usageByDay.at(-1);
    // User-attributed only: the improve-sourced search is not counted.
    expect(today).toMatchObject({ search: 1, show: 1, feedbackPositive: 1, feedbackNegative: 1, curate: 0 });
  });

  test("GET /api/bundles: cards with git status and asset counts, plus the index state", async () => {
    await seed();
    const s = await start();
    const bundles = await data(s, "/api/bundles");
    expect(bundles.defaultBundle).toBe("stash");
    expect(bundles.bundles).toHaveLength(1);
    const card = bundles.bundles[0];
    expect(card).toMatchObject({ name: "stash", kind: "filesystem", default: true, writable: true, exists: true });
    expect(card.byType.knowledge).toBeGreaterThanOrEqual(2);
    expect(card.git).toMatchObject({ upstream: null, ahead: null, behind: null });
    expect(card.git.branch).toBeTruthy();
    expect(card.git.lastCommit.subject).toStartWith("akm save");
    expect(bundles.index.entryCount).toBeGreaterThanOrEqual(2);
    expect(bundles.index).toMatchObject({ hasEmbeddings: false, embeddingCount: 0 });
    expect(bundles.index.lastBuiltAt).toBeTruthy();
  });

  test("GET /api/bundles reports ahead and behind against the remote-tracking branch without fetching", async () => {
    await seed();
    const remote = fs.mkdtempSync(path.join(storage.root, "remote-"));
    git(remote, ["init", "-q", "--bare"]);
    const stash = storage.stashDir;
    git(stash, ["remote", "add", "origin", remote]);
    git(stash, ["push", "-q", "-u", "origin", "HEAD"]);
    fs.writeFileSync(path.join(stash, "knowledge", "ahead.md"), "# ahead\n");
    git(stash, ["add", "knowledge"]);
    git(stash, ["commit", "-q", "-m", "local only"]);
    const fetchHead = path.join(stash, ".git", "FETCH_HEAD");
    const before = fs.existsSync(fetchHead);

    const s = await start();
    const { git: status } = (await data(s, "/api/bundles")).bundles[0];

    expect(status).toMatchObject({ upstream: expect.stringContaining("origin/"), ahead: 1, behind: 0 });
    expect(status.lastCommit.subject).toBe("local only");
    expect(fs.existsSync(fetchHead)).toBe(before);
  });

  test("GET /api/config: effective config with provenance, engines, and no secret values", async () => {
    await seed();
    const s = await start();
    const config = await data(s, "/api/config");
    expect(config.exists).toBe(true);
    const sources = Object.fromEntries(config.entries.map((e: { path: string; source: string }) => [e.path, e.source]));
    expect(sources.semanticSearchMode).toBe("file");
    expect(sources["engines.default.model"]).toBe("file");
    expect(config.engines).toHaveLength(1);
    expect(config.engines[0]).toMatchObject({ name: "default", kind: "llm", model: "chat-model" });
    expect(config.engines[0].endpoint).toContain("token=%5Bredacted%5D");
    expect(config.engines[0].apiKey).toBeUndefined();
    expect(config.config.someToken).toBe("[redacted]");
  });

  test("GET /api/proposals and /api/proposals/:id", async () => {
    await seed();
    const created = createProposal(storage.stashDir, {
      ref: "lessons/rg",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: storage.stashDir },
      payload: { content: LESSON, frontmatter: { description: "Use ripgrep" } },
    });
    const s = await start();

    const pending = await data(s, "/api/proposals?status=pending");
    expect(pending).toMatchObject({ status: "pending", totalCount: 1, bySource: { reflect: 1 } });
    expect(pending.proposals[0]).toMatchObject({
      id: created.id,
      source: "reflect",
      ref: "stash//lessons/rg",
      status: "pending",
    });
    expect(pending.proposals[0].waitingSince).toBeTruthy();

    expect((await data(s, "/api/proposals?status=recent")).totalCount).toBe(0);

    const detail = await data(s, `/api/proposals/${created.id}`);
    expect(detail.proposal).toMatchObject({ id: created.id, ref: "stash//lessons/rg" });
    expect(detail.proposal.backupContent).toBeUndefined();
    expect(detail.proposal.changes).toEqual([{ op: expect.any(String), path: expect.any(String) }]);
    expect(detail.validation).toMatchObject({ ok: true });
    expect(detail.diffError).toBeNull();
    expect(detail.diff.isNew).toBe(true);
    expect(detail.diff.unified).toContain("Prefer rg over grep.");
    // A ref resolves to its newest pending proposal, like `akm proposal show`.
    expect((await data(s, `/api/proposals/${encodeURIComponent("stash//lessons/rg")}`)).proposal.id).toBe(created.id);
    // An id prefix resolves like `akm proposal show`.
    expect((await data(s, `/api/proposals/${created.id.slice(0, 8)}`)).proposal.id).toBe(created.id);

    const missing = await api(s, "/api/proposals/does-not-exist");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false, code: "PROPOSAL_NOT_FOUND" });
    const bad = await api(s, "/api/proposals?status=bogus");
    expect(bad.status).toBe(400);
  });

  test("GET /api/changes: recent commits of the write-target stash, classified by origin", async () => {
    await seed();
    const s = await start();
    const changes = await data(s, "/api/changes?limit=10");
    expect(changes).toMatchObject({ bundle: "stash", git: true });
    const origins = changes.commits.map((c: { origin: string }) => c.origin);
    expect(origins.slice(0, 3)).toEqual(["sync", "accept", "improve-sync"]);
    expect(changes.commits[0]).toMatchObject({ subject: expect.stringContaining("akm save"), author: "akm-test" });
    expect(changes.commits[0].paths).toEqual(["knowledge/more.md"]);
    expect((await data(s, "/api/changes?limit=1")).commits).toHaveLength(1);
  });

  test("GET /api/search returns what akmSearch returns, with bundle and type filters", async () => {
    await seed();
    const s = await start();
    const viaApi = await data(s, "/api/search?q=deploy&limit=10");
    const direct = await akmSearch({ query: "deploy", limit: 10, readOnly: true });
    expect(viaApi.hits.map((h: { ref: string }) => h.ref)).toEqual(direct.hits.map((h) => (h as { ref: string }).ref));
    expect(viaApi.hits.length).toBeGreaterThanOrEqual(2);

    // ...and the same refs `akm search` prints.
    const cli = await runCliCapture(["search", "deploy", "--limit", "10", "--format", "json"]);
    const cliRefs = (JSON.parse(cli.stdout) as { hits: Array<{ ref: string }> }).hits.map((h) => h.ref);
    expect(viaApi.hits.map((h: { ref: string }) => h.ref)).toEqual(cliRefs);

    const typed = await data(s, "/api/search?q=deploy&type=knowledge");
    expect(typed.hits.every((h: { type: string }) => h.type === "knowledge")).toBe(true);
    const named = await data(s, "/api/search?q=deploy&bundle=stash");
    expect(named.hits.length).toBeGreaterThan(0);
    expect((await api(s, "/api/search?q=deploy&bundle=nope")).status).toBe(400);
  });

  test("GET /api/asset returns what akm show returns, plus feedback counts and history", async () => {
    await seed();
    const s = await start();
    const result = await data(s, "/api/asset?ref=knowledge/guide");
    expect(result.redacted).toBe(false);
    expect(result.durableRef).toBe("stash//knowledge/guide");
    expect(result.asset).toMatchObject({ type: "knowledge", name: "guide" });
    expect(result.asset.content).toContain("Run the deploy script.");
    expect(result.feedback.counts).toEqual({ positive: 1, negative: 1 });
    expect(result.feedback.history).toHaveLength(2);
    expect(result.feedback.history.find((h: { signal: string }) => h.signal === "positive").reason).toBe("clear");

    expect((await api(s, "/api/asset")).status).toBe(400);
    expect((await api(s, "/api/asset?ref=knowledge/absent")).status).toBe(404);
  });
});

describe("secrets and read-only guarantees", () => {
  const ENDPOINTS = [
    "/api/meta",
    "/api/overview",
    "/api/bundles",
    "/api/config",
    "/api/proposals?status=pending",
    "/api/proposals?status=recent",
    "/api/changes",
    "/api/search?q=deploy",
    "/api/search?q=prod",
    "/api/search?q=deploy-key",
    "/api/asset?ref=knowledge/guide",
    "/api/asset?ref=env/prod",
    "/api/asset?ref=secrets/deploy-key",
    "/api/asset?ref=stash//env/prod",
  ];

  test("no response carries a planted config, env or secret value; env and secret assets are stubs", async () => {
    await seed();
    const s = await start();
    for (const endpoint of ENDPOINTS) {
      const text = await (await api(s, endpoint)).text();
      for (const planted of PLANTED) expect(`${endpoint} ${text}`).not.toContain(planted);
    }
    for (const ref of ["env/prod", "secrets/deploy-key"]) {
      const stub = await data(s, `/api/asset?ref=${ref}`);
      expect(stub).toMatchObject({ redacted: true, ref });
      expect(stub.asset).toBeUndefined();
    }
  });

  test("a browse session writes no usage events and leaves state.db and index.db unchanged", async () => {
    await seed();
    const s = await start();
    const countRows = (table: string): number => {
      const db = openStateDatabase();
      try {
        return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    const before = {
      usage: countRows("usage_events"),
      events: countRows("events"),
      state: sha1(getStateDbPath()),
      index: sha1(getDbPath()),
    };

    for (const endpoint of ENDPOINTS) await api(s, endpoint);
    await api(s, "/api/search?q=deploy&type=knowledge");
    await api(s, "/api/asset?ref=knowledge/notes");
    await api(s, "/api/overview?probe=0&since=7d");

    expect(countRows("usage_events")).toBe(before.usage);
    expect(countRows("events")).toBe(before.events);
    expect(sha1(getStateDbPath())).toBe(before.state);
    expect(sha1(getDbPath())).toBe(before.index);
  });

  test("with no state.db yet, the overview reports it and does not create it", async () => {
    const stash = storage.stashDir;
    writeSandboxConfig({ ...makeConfig(stash), semanticSearchMode: "off" });
    resetConfigCache();
    expect(fs.existsSync(getStateDbPath())).toBe(false);
    const s = await start();

    const overview = await data(s, "/api/overview");
    expect(overview.health.status).toBe("fail");
    expect(overview.health.hardChecks[0].name).toBe("state-db-readable");
    expect(overview.improveRuns).toEqual([]);
    expect(await data(s, "/api/proposals")).toMatchObject({ totalCount: 0 });
    expect(fs.existsSync(getStateDbPath())).toBe(false);
  });
});
