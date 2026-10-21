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
import { akmProposalAccept } from "../../../src/commands/proposal/proposal";
import { createProposal } from "../../../src/commands/proposal/repository";
import { akmSearch } from "../../../src/commands/read/search";
import { DIFF_SIDE_MAX_CHARS } from "../../../src/commands/ui/api";
import { MAX_BODY_BYTES, startUiServer, type UiServer } from "../../../src/commands/ui/server";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { acquireAssetMutationLease } from "../../../src/indexer/index-writer-lock";
import { akmIndex } from "../../../src/indexer/indexer";
import { recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { runCliCapture } from "../../_helpers/cli";
import { makeConfig } from "../../_helpers/factories";
import { git, makeGitRepo } from "../../_helpers/git";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

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
  test("starts on a random port, serves the UI without a token, and embeds no data", async () => {
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

  test("only GET is accepted outside the proposal writes: a non-GET needs the token, then is refused", async () => {
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
    expect(meta).toMatchObject({ host: "127.0.0.1", port: s.port, stashDir: storage.stashDir });
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
    // A new asset has no earlier text; the proposed text comes back whole.
    expect(detail.diff).toMatchObject({ before: null, truncated: false, redacted: false });
    expect(detail.diff.after).toContain("Prefer rg over grep.");
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

  test("GET /api/proposals/:id returns both sides of an update, and nothing for an env or secret target", async () => {
    await seed();
    const proposed = GUIDE.replace("description: Deploy guide\n", "description: Deploy guide\nwhen_to_use: Shipping\n");
    const update = createProposal(storage.stashDir, {
      ref: "knowledge/guide",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: storage.stashDir },
      payload: { content: proposed, frontmatter: { when_to_use: "Shipping" } },
    });
    const envProposal = createProposal(storage.stashDir, {
      ref: "env/prod",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: storage.stashDir },
      payload: { content: "API_TOKEN=proposed-env-value-0006\n" },
    });
    const secretProposal = createProposal(storage.stashDir, {
      ref: "secrets/deploy-key",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: storage.stashDir },
      payload: { content: "proposed-secret-value-0007" },
    });
    const s = await start();
    const stateBefore = sha1(getStateDbPath());

    const detail = await data(s, `/api/proposals/${update.id}`);
    expect(detail.diffError).toBeNull();
    expect(detail.diff).toMatchObject({ isNew: false, before: GUIDE, truncated: false, redacted: false });
    // The stored proposal is the payload with akm's frontmatter normalisation, so `after` is what accept would write.
    expect(detail.diff.after).toContain("when_to_use: Shipping");
    expect(detail.diff.after).toContain("Run the deploy script.");
    expect(detail.diff.unified).toContain("+when_to_use: Shipping");

    for (const [id, leaked] of [
      [envProposal.id, ["proposed-env-value-0006", PLANTED_ENV_VALUE]],
      [secretProposal.id, ["proposed-secret-value-0007", PLANTED_SECRET_FILE]],
    ] as const) {
      const sensitive = await data(s, `/api/proposals/${id}`);
      expect(sensitive.diff).toMatchObject({ before: null, after: null, redacted: true, truncated: false });
      const text = JSON.stringify(sensitive);
      for (const value of leaked) expect(text).not.toContain(value);
    }
    // Reading wrote nothing.
    expect(sha1(getStateDbPath())).toBe(stateBefore);
  });

  test("GET /api/proposals/:id cuts a very large side and says so", async () => {
    await seed();
    const huge = `---\ndescription: Big\n---\n${"x".repeat(DIFF_SIDE_MAX_CHARS + 10)}\n`;
    const created = createProposal(storage.stashDir, {
      ref: "knowledge/big",
      source: "reflect",
      sourceRun: "run-1",
      target: { source: "stash", root: storage.stashDir },
      payload: { content: huge },
    });
    const s = await start();
    const detail = await data(s, `/api/proposals/${created.id}`);
    expect(detail.diff.truncated).toBe(true);
    expect(detail.diff.after).toHaveLength(DIFF_SIDE_MAX_CHARS);
    expect(detail.diff.unified).toContain("xxxx");
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

// ── Proposal accept / reject ────────────────────────────────────────────────

const NOTES_REWRITE = "---\ndescription: Deploy notes, rewritten\n---\n# Notes\nRewritten by a proposal.\n";

interface RawResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted field by field in each test
  body: any;
}

/** A write exactly as the page sends it, with `overrides` replacing (or, with `null`, dropping) a header. */
function write(
  s: UiServer,
  requestPath: string,
  body: unknown,
  overrides: Record<string, string | null> = {},
  method = "POST",
): Promise<RawResponse> {
  const headers: Record<string, string | null> = {
    "X-Akm-Ui-Token": s.token,
    "Content-Type": "application/json",
    Origin: `http://${s.host}:${s.port}`,
    ...overrides,
  };
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: s.host,
        port: s.port,
        path: requestPath,
        method,
        headers: {
          ...Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== null)),
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // A non-JSON body is asserted on by the status.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function propose(ref: string, content: string = LESSON): string {
  return createProposal(storage.stashDir, {
    ref,
    source: "reflect",
    sourceRun: "run-1",
    target: { source: "stash", root: storage.stashDir },
    payload: { content, frontmatter: { description: "Use ripgrep", when_to_use: "Searching repos" } },
  }).id;
}

const commitCount = (): number => Number(git(storage.stashDir, ["rev-list", "--count", "HEAD"]).trim());
const lastSubject = (): string => git(storage.stashDir, ["log", "-1", "--format=%s"]).trim();
const lessonFile = (name: string): string => path.join(storage.stashDir, "lessons", `${name}.md`);

describe("proposal writes", () => {
  test("accept writes the asset and makes exactly one commit", async () => {
    await seed();
    const id = propose("lessons/rg");
    const s = await start();
    const before = commitCount();

    const response = await write(s, `/api/proposals/${id}/accept`, {});
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toMatchObject({ ok: true, id, ref: "stash//lessons/rg" });
    expect(response.body.data.proposal).toMatchObject({ id, status: "accepted" });
    expect(response.body.data.proposal.backupContent).toBeUndefined();
    expect(fs.readFileSync(lessonFile("rg"), "utf8")).toContain("Prefer rg over grep.");

    expect(commitCount()).toBe(before + 1);
    expect(lastSubject()).toBe(`akm accept: reflect ${id.slice(0, 8)} stash//lessons/rg`);
    expect(response.body.data.commit).toMatchObject({ subject: lastSubject() });
    expect(response.body.data.commit.sha).toBe(git(storage.stashDir, ["rev-parse", "HEAD"]).trim());

    expect((await data(s, `/api/proposals/${id}`)).proposal.status).toBe("accepted");
    expect((await data(s, "/api/proposals?status=pending")).totalCount).toBe(0);
  });

  test("a decision from the page is recorded exactly like the CLI's", async () => {
    await seed();
    const viaCli = propose("lessons/cli");
    const viaUi = propose("lessons/ui");
    const s = await start();
    await akmProposalAccept({ id: viaCli });
    expect((await write(s, `/api/proposals/${viaUi}/accept`, {})).status).toBe(200);

    const recorded = async (name: string, id: string) => {
      const db = openStateDatabase();
      try {
        const events = db
          .prepare("SELECT event_type, metadata_json FROM events WHERE ref = ? ORDER BY id")
          .all(`stash//lessons/${name}`) as Array<{ event_type: string; metadata_json: string }>;
        return {
          events: events.map((e) => [e.event_type, Object.keys(JSON.parse(e.metadata_json)).sort()]),
          review: (await data(s, `/api/proposals/${id}`)).proposal.review.outcome,
        };
      } finally {
        db.close();
      }
    };
    const cli = await recorded("cli", viaCli);
    expect(cli.events.length).toBeGreaterThan(0);
    expect(await recorded("ui", viaUi)).toEqual(cli);
  });

  test("batch accept of three makes one commit and reports each id, including one that fails", async () => {
    await seed();
    const ids = [propose("lessons/a"), propose("lessons/b"), propose("lessons/c")];
    const missing = "00000000-0000-4000-8000-000000000000";
    const s = await start();
    const before = commitCount();

    const response = await write(s, "/api/proposals/accept", { ids: [ids[0], missing, ids[1], ids[2], ids[0]] });
    expect(response.status).toBe(200);
    const result = response.body.data;
    expect(result).toMatchObject({ accepted: 3, failed: 1 });
    expect(result.results.map((r: Json) => [r.id, r.ok])).toEqual([
      [ids[0], true],
      [missing, false],
      [ids[1], true],
      [ids[2], true],
    ]);
    expect(result.results[1]).toMatchObject({ ok: false, code: "PROPOSAL_NOT_FOUND" });
    expect(result.results[1].error).toContain("not found");
    for (const name of ["a", "b", "c"]) expect(fs.existsSync(lessonFile(name))).toBe(true);

    expect(commitCount()).toBe(before + 1);
    expect(lastSubject()).toBe("akm proposal accept: 3 accepted (reflect 3)");
    expect(result.commit).toMatchObject({ subject: lastSubject() });
    expect((await data(s, "/api/proposals?status=pending")).totalCount).toBe(0);
  });

  test("batch input is bounded: 1 to 200 ids, strings only", async () => {
    await seed();
    const s = await start();
    for (const body of [{}, { ids: [] }, { ids: "x" }, { ids: [1] }, { ids: [""] }, { ids: ["x".repeat(201)] }, []]) {
      const response = await write(s, "/api/proposals/accept", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ ok: false });
    }
    const tooMany = await write(s, "/api/proposals/accept", { ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) });
    expect(tooMany.status).toBe(400);
    const full = await write(s, "/api/proposals/accept", { ids: Array.from({ length: 200 }, (_, i) => `id-${i}`) });
    expect(full.status).toBe(200);
    expect(full.body.data).toMatchObject({ accepted: 0, failed: 200, commit: null });
  });

  test("reject records the reason and leaves the asset and the repository alone", async () => {
    await seed();
    const notes = path.join(storage.stashDir, "knowledge", "notes.md");
    const id = propose("knowledge/notes", NOTES_REWRITE);
    const s = await start();
    const hash = sha1(notes);
    const before = commitCount();

    const response = await write(s, `/api/proposals/${id}/reject`, { reason: "  Not what the page needs.  " });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ ok: true, id, reason: "Not what the page needs." });
    expect(response.body.data.proposal.status).toBe("rejected");

    expect(sha1(notes)).toBe(hash);
    expect(commitCount()).toBe(before);
    const detail = await data(s, `/api/proposals/${id}`);
    expect(detail.proposal.status).toBe("rejected");
    expect(detail.proposal.review).toMatchObject({ outcome: "rejected", reason: "Not what the page needs." });
    expect((await data(s, "/api/proposals?status=recent")).proposals[0]).toMatchObject({ id, status: "rejected" });
  });

  test("a rejection needs a reason of 1 to 2000 characters", async () => {
    await seed();
    const id = propose("lessons/rg");
    const s = await start();
    for (const body of [{}, { reason: "" }, { reason: "   \n " }, { reason: 5 }, { reason: "x".repeat(2001) }, []]) {
      const response = await write(s, `/api/proposals/${id}/reject`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ ok: false });
    }
    expect((await write(s, `/api/proposals/${id}/reject`, "{")).status).toBe(400);
    expect((await data(s, `/api/proposals/${id}`)).proposal.status).toBe("pending");
    expect((await write(s, `/api/proposals/${id}/reject`, { reason: "x".repeat(2000) })).status).toBe(200);
  });

  test("a stale target is a 409 PROPOSAL_STALE and nothing is written", async () => {
    await seed();
    const notes = path.join(storage.stashDir, "knowledge", "notes.md");
    const id = propose("knowledge/notes", NOTES_REWRITE);
    fs.writeFileSync(notes, "---\ndescription: Edited since\n---\n# Notes\nEdited by hand.\n");
    const edited = sha1(notes);
    const s = await start();
    const before = commitCount();

    const response = await write(s, `/api/proposals/${id}/accept`, {});
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ ok: false, code: "PROPOSAL_STALE" });
    expect(response.body.error).toContain("target changed after proposal");
    expect(sha1(notes)).toBe(edited);
    expect(commitCount()).toBe(before);
    expect((await data(s, `/api/proposals/${id}`)).proposal.status).toBe("pending");

    // Inside a batch the same failure is reported per id.
    const batch = await write(s, "/api/proposals/accept", { ids: [id] });
    expect(batch.body.data.results[0]).toMatchObject({ ok: false, code: "PROPOSAL_STALE" });
  });

  test("unknown ids are 404, decided proposals are 409, a held lease is 409", async () => {
    await seed();
    const id = propose("lessons/rg");
    const other = propose("lessons/other");
    const s = await start();
    const missing = "00000000-0000-4000-8000-000000000000";

    for (const action of ["accept", "reject"]) {
      const response = await write(s, `/api/proposals/${missing}/${action}`, { reason: "gone" });
      expect(response.status, action).toBe(404);
      expect(response.body).toMatchObject({ ok: false, code: "PROPOSAL_NOT_FOUND" });
    }

    expect((await write(s, `/api/proposals/${id}/reject`, { reason: "no" })).status).toBe(200);
    const accepted = await write(s, `/api/proposals/${id}/accept`, {});
    expect(accepted.status).toBe(409);
    expect(accepted.body).toMatchObject({ ok: false, code: "PROPOSAL_NOT_PENDING" });
    expect((await write(s, `/api/proposals/${other}/accept`, {})).status).toBe(200);
    const rejected = await write(s, `/api/proposals/${other}/reject`, { reason: "late" });
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ ok: false, code: "PROPOSAL_NOT_PENDING" });

    const third = propose("lessons/third");
    const lease = await acquireAssetMutationLease({ purpose: "test-holder", mode: "try" });
    expect(lease).toBeDefined();
    try {
      const held = await write(s, `/api/proposals/${third}/accept`, {});
      expect(held.status).toBe(409);
      expect(held.body).toMatchObject({ ok: false, code: "ASSET_MUTATION_LEASE_HELD" });
    } finally {
      lease?.release();
    }
    expect((await write(s, `/api/proposals/${third}/accept`, {})).status).toBe(200);
  });

  test("a write is refused without the token header, with a foreign Origin, or without a JSON content type", async () => {
    await seed();
    const id = propose("lessons/rg");
    const s = await start();
    const before = { state: sha1(getStateDbPath()), commits: commitCount() };
    const path_ = `/api/proposals/${id}/accept`;
    const own = `http://${s.host}:${s.port}`;

    const cases: Array<[string, Promise<RawResponse>, number, string]> = [
      ["no token", write(s, path_, {}, { "X-Akm-Ui-Token": null }), 401, "UNAUTHORIZED"],
      ["wrong token", write(s, path_, {}, { "X-Akm-Ui-Token": "wrong" }), 401, "UNAUTHORIZED"],
      [
        "token only in the query string",
        write(s, `${path_}?token=${s.token}`, {}, { "X-Akm-Ui-Token": null }),
        401,
        "UNAUTHORIZED",
      ],
      ["no Origin", write(s, path_, {}, { Origin: null }), 403, "ORIGIN_NOT_ALLOWED"],
      ["foreign Origin", write(s, path_, {}, { Origin: "http://evil.example" }), 403, "ORIGIN_NOT_ALLOWED"],
      ["Origin 'null'", write(s, path_, {}, { Origin: "null" }), 403, "ORIGIN_NOT_ALLOWED"],
      [
        "Origin on another port",
        write(s, path_, {}, { Origin: `http://127.0.0.1:${s.port + 1}` }),
        403,
        "ORIGIN_NOT_ALLOWED",
      ],
      ["https Origin", write(s, path_, {}, { Origin: `https://127.0.0.1:${s.port}` }), 403, "ORIGIN_NOT_ALLOWED"],
      ["Origin with a path", write(s, path_, {}, { Origin: `${own}/` }), 403, "ORIGIN_NOT_ALLOWED"],
      [
        "form content type",
        write(s, path_, "a=b", { "Content-Type": "application/x-www-form-urlencoded" }),
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      ],
      ["plain text", write(s, path_, "{}", { "Content-Type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE"],
      ["no content type", write(s, path_, "{}", { "Content-Type": null }), 415, "UNSUPPORTED_MEDIA_TYPE"],
    ];
    for (const [name, pending, status, code] of cases) {
      const response = await pending;
      expect(response.status, name).toBe(status);
      expect(response.body, name).toMatchObject({ ok: false, code });
    }
    // The same rules guard the other two write routes.
    for (const route of [`/api/proposals/${id}/reject`, "/api/proposals/accept"]) {
      expect((await write(s, route, { reason: "r", ids: [id] }, { Origin: "http://evil.example" })).status).toBe(403);
      expect((await write(s, route, { reason: "r", ids: [id] }, { "X-Akm-Ui-Token": null })).status).toBe(401);
    }

    expect(sha1(getStateDbPath())).toBe(before.state);
    expect(commitCount()).toBe(before.commits);
    expect(fs.existsSync(lessonFile("rg"))).toBe(false);

    // The same request, complete, goes through; a charset parameter is fine.
    const ok = await write(s, path_, {}, { "Content-Type": "application/json; charset=utf-8" });
    expect(ok.status).toBe(200);
  });

  test("a body over the limit is a 413 and is not parsed", async () => {
    await seed();
    const id = propose("lessons/rg");
    const s = await start();
    const big = JSON.stringify({ reason: "x".repeat(MAX_BODY_BYTES) });
    const response = await write(s, `/api/proposals/${id}/reject`, big);
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ ok: false, code: "BODY_TOO_LARGE" });
    expect((await data(s, `/api/proposals/${id}`)).proposal.status).toBe("pending");
  });

  test("every other path stays GET-only, with or without the write headers", async () => {
    await seed();
    const id = propose("lessons/rg");
    const s = await start();
    const attempts: Array<[string, string]> = [
      ["POST", "/api/proposals"],
      ["POST", `/api/proposals/${id}`],
      ["POST", `/api/proposals/${id}/revert`],
      ["POST", `/api/proposals/${id}/accept/extra`],
      ["POST", "/api/proposals/accept/extra"],
      ["POST", "/api/config"],
      ["POST", "/api/asset?ref=knowledge/guide"],
      ["PUT", `/api/proposals/${id}/accept`],
      ["DELETE", `/api/proposals/${id}`],
      ["PATCH", "/api/proposals/accept"],
    ];
    for (const [method, route] of attempts) {
      const response = await write(s, route, {}, {}, method);
      expect(response.status, `${method} ${route}`).toBe(405);
      expect(response.body).toMatchObject({ ok: false, code: "METHOD_NOT_ALLOWED" });
    }
    // A GET of a write path is not a decision either.
    expect((await api(s, `/api/proposals/${id}/accept`)).status).toBe(404);
    expect((await api(s, "/api/proposals/accept")).status).toBe(404);
    expect((await data(s, `/api/proposals/${id}`)).proposal.status).toBe("pending");
  });
});

describe("workspace actions", () => {
  async function writableConfig() {
    await seed();
    const config = loadConfig();
    writeSandboxConfig({
      ...config,
      engines: { default: { ...config.engines!.default!, apiKey: "$AKM_UI_TEST_KEY" } },
    });
  }
  test("asset navigation resolves indexed relative targets within the owning bundle and keeps fragment selectors", async () => {
    await seed();
    const guide = path.join(storage.stashDir, "knowledge", "guide.md");
    fs.writeFileSync(
      guide,
      `${GUIDE}\n## Details\n[notes](notes.md#notes) [missing](missing.md) [unsafe](javascript:bad)\n`,
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const s = await start();
    const result = await data(s, "/api/asset?ref=knowledge/guide");
    expect(result.links).toEqual({ "notes.md#notes": "stash//knowledge/notes#notes" });
    expect(result.headings.map((h: Json) => h.slug)).toEqual(["deploy-guide", "details"]);
  });

  test("search forwards explicit historical and scope controls without recording usage", async () => {
    await seed();
    for (const [name, belief, user] of [
      ["current", "active", "alice"],
      ["old", "deprecated", "alice"],
      ["other", "active", "bob"],
    ]) {
      fs.writeFileSync(
        path.join(storage.stashDir, "memories", `${name}.md`),
        `---\ntitle: Gateway\ndescription: Gateway memory\nbeliefState: ${belief}\nscope:\n  user: ${user}\n---\n# Gateway\nUse the gateway.\n`,
      );
    }
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const s = await start();
    const current = await data(s, "/api/search?q=gateway&type=memory&scope_user=alice");
    const historical = await data(s, "/api/search?q=gateway&type=memory&belief=historical&scope_user=alice");
    const all = await data(s, "/api/search?q=gateway&type=memory&belief=all&scope_user=alice");
    expect(current.hits.map((h: Json) => h.name)).toEqual(["current"]);
    expect(historical.hits.map((h: Json) => h.name)).toEqual(["old"]);
    const direct = await akmSearch({
      query: "gateway",
      type: "memory",
      source: "local",
      belief: "all",
      filters: { user: "alice" },
      readOnly: true,
    });
    expect(all.hits.map((h: Json) => h.ref)).toEqual(direct.hits.flatMap((h) => ("ref" in h ? [h.ref] : [])));
    expect((await api(s, "/api/search?belief=invalid")).status).toBe(400);
  });

  test("document history is file-scoped, read-only and only accepts returned revision IDs", async () => {
    await seed();
    const guide = path.join(storage.stashDir, "knowledge", "guide.md");
    fs.writeFileSync(guide, `${GUIDE}\nReviewed procedure.\n`);
    git(storage.stashDir, ["add", "knowledge/guide.md"]);
    git(storage.stashDir, ["commit", "-qm", "Review guide"]);
    const s = await start();
    const indexBefore = sha1(getDbPath());
    const stateBefore = sha1(getStateDbPath());
    const history = await data(s, "/api/asset/history?ref=knowledge/guide");
    expect(history.available).toBe(true);
    expect(history.commits).toHaveLength(2);
    expect(history.commits[0].subject).toBe("Review guide");
    const revision = history.commits[0].sha;
    const selected = await data(s, `/api/asset/history?ref=knowledge/guide&revision=${revision}`);
    expect(selected.diff.before).toBe(GUIDE);
    expect(selected.diff.after).toBe(`${GUIDE}\nReviewed procedure.\n`);
    expect(selected.diff.unified).toContain("+Reviewed procedure.");
    expect((await api(s, "/api/asset/history?ref=knowledge/guide&revision=HEAD")).status).toBe(400);
    expect((await data(s, "/api/asset/history?ref=env/prod")).available).toBe(false);
    expect(sha1(getDbPath())).toBe(indexBefore);
    expect(sha1(getStateDbPath())).toBe(stateBefore);
    fs.rmSync(path.join(storage.stashDir, ".git"), { recursive: true });
    expect((await data(s, "/api/asset/history?ref=knowledge/guide")).available).toBe(false);
  });

  test("feedback enforces CLI reason policy and persists user-attributed tags, counts and ranking effects", async () => {
    await seed();
    const s = await start();
    const missing = await write(s, "/api/feedback", { ref: "stash//knowledge/guide", signal: "negative" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("reason");
    const result = await withEnv({ AKM_EVENT_SOURCE: "improve" }, () =>
      write(s, "/api/feedback", {
        ref: "stash//knowledge/guide",
        signal: "positive",
        reason: "Clear procedure",
        tags: ["status:tested", "team:platform"],
      }),
    );
    expect(result.status, result.body.error).toBe(200);
    expect(result.body.data.rankingUpdate.applied).toBe(true);
    const asset = await data(s, "/api/asset?ref=stash//knowledge/guide");
    expect(asset.feedback.counts.positive).toBe(2);
    expect(asset.feedback.history).toContainEqual(
      expect.objectContaining({
        signal: "positive",
        source: "user",
        reason: "Clear procedure",
        tags: ["status:tested", "team:platform"],
      }),
    );
    // A reload observes the stored event; no in-memory UI vote store exists.
    expect((await data(s, "/api/asset?ref=knowledge/guide")).feedback.counts.positive).toBe(2);
    writeSandboxConfig({ ...loadConfig(), feedback: { requireReason: false } });
    expect((await write(s, "/api/feedback", { ref: "stash//knowledge/guide", signal: "negative" })).status).toBe(200);
  });

  test("settings save only allowed fields and preserve secrets, unknown values and disabled/default state", async () => {
    await writableConfig();
    const config = loadConfig();
    writeSandboxConfig({
      ...config,
      bundles: {
        ...config.bundles,
        stash: {
          ...config.bundles!.stash!,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
      unrelated: { keep: [1, "two"] },
    });
    const s = await start();
    const changed = await write(s, "/api/bundles/settings", {
      bundle: "stash",
      enabled: false,
      writable: false,
      componentWritability: { main: false },
      defaultBundle: "",
      defaultWriteTarget: "",
      engines: { default: { apiKey: "[redacted]" } },
      unrelated: "overwrite attempt",
    });
    expect(changed.status, changed.body.error).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8"));
    expect(saved.bundles.stash).toMatchObject({
      enabled: false,
      writable: false,
      components: { main: { writable: false } },
    });
    expect(saved.engines.default.apiKey).toBe("$AKM_UI_TEST_KEY");
    expect(saved.someToken).toBe(PLANTED_CONFIG_TOKEN);
    expect(saved.unrelated).toEqual({ keep: [1, "two"] });
    const listed = await data(s, "/api/bundles");
    expect(listed.bundles.find((b: Json) => b.name === "stash")).toMatchObject({ enabled: false, writable: false });
    expect((await write(s, "/api/bundles/settings", { defaultBundle: "missing" })).status).toBe(400);
    expect((await write(s, "/api/bundles/settings", { bundle: "constructor", enabled: true })).status).toBe(400);
    expect(
      (await write(s, "/api/bundles/settings", { bundle: "stash", componentWritability: { constructor: true } }))
        .status,
    ).toBe(400);
    expect((await write(s, "/api/bundles/settings", { defaultWriteTarget: "" })).status).toBe(200);
    expect(loadConfig().defaultWriteTarget).toBeUndefined();
    expect(
      (await write(s, "/api/bundles/settings", { bundle: "stash", enabled: true, defaultWriteTarget: "stash" })).status,
    ).toBe(200);
    expect(loadConfig().defaultWriteTarget).toBe("stash");
  });

  test("bundle lifecycle uses real local-source add, update and confirmed remove operations", async () => {
    await writableConfig();
    const source = path.join(storage.root, "extra");
    fs.mkdirSync(path.join(source, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(source, "knowledge", "extra.md"), "# Extra\nFirst revision.\n");
    const s = await start();
    expect((await write(s, "/api/bundles/add", { source, name: "extra" })).status).toBe(200);
    expect((await data(s, "/api/bundles")).bundles.map((b: Json) => b.name)).toContain("extra");
    fs.writeFileSync(path.join(source, "knowledge", "extra.md"), "# Extra\nUpdated revision.\n");
    expect((await write(s, "/api/bundles/update", { bundle: "extra" })).status).toBe(200);
    expect((await data(s, "/api/asset?ref=extra//knowledge/extra")).asset.content).toContain("Updated revision");
    expect((await write(s, "/api/bundles/remove", { bundle: "extra" })).status).toBe(400);
    expect((await write(s, "/api/bundles/remove", { bundle: "extra", confirm: true })).status).toBe(200);
    expect((await data(s, "/api/bundles")).bundles.map((b: Json) => b.name)).not.toContain("extra");
    expect(fs.existsSync(path.join(source, "knowledge", "extra.md"))).toBe(true);
  });

  test("config-affecting actions refuse unrelated sanitizer changes rather than losing legacy credentials", async () => {
    await seed();
    const config = loadConfig();
    writeSandboxConfig({ engines: { default: { ...config.engines!.default!, apiKey: PLANTED_API_KEY } } });
    const s = await start();
    const configPath = path.join(storage.configDir, "akm", "config.json");
    const before = fs.readFileSync(configPath, "utf8");
    for (const action of ["settings", "add", "update", "remove"]) {
      const result = await write(s, `/api/bundles/${action}`, {
        bundle: "stash",
        writable: false,
        source: storage.stashDir,
        confirm: true,
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("sanitizer");
      expect(result.body.error).not.toContain(PLANTED_API_KEY);
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    }
  });

  test("local settings preserve inherited configuration and do not flatten the effective config", async () => {
    await writableConfig();
    const configPath = path.join(storage.configDir, "akm", "config.json");
    const basePath = path.join(storage.configDir, "akm", "shared.json");
    fs.writeFileSync(
      basePath,
      JSON.stringify({ configVersion: "0.9.0", inheritedExtra: { keep: true }, archiveRetentionDays: 17 }),
    );
    writeSandboxConfig({ extends: "./shared.json" });
    const s = await start();
    const result = await write(s, "/api/bundles/settings", { bundle: "stash", writable: false });
    expect(result.status, result.body.error).toBe(200);
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(saved.extends).toBe("./shared.json");
    expect(saved.inheritedExtra).toBeUndefined();
    expect(saved.archiveRetentionDays).toBeUndefined();
    expect(loadConfig().archiveRetentionDays).toBe(17);
    expect(JSON.parse(fs.readFileSync(basePath, "utf8")).inheritedExtra).toEqual({ keep: true });
  });

  test("knowledge creation preserves Markdown through import and refuses overwrites and path escapes", async () => {
    await writableConfig();
    const s = await start();
    const content =
      "---\ntitle: New knowledge\ncustom: [keep, me]\n---\n# New knowledge\n\n| A | B |\n| --- | --- |\n| one | two |\n";
    const result = await write(s, "/api/knowledge/create", { bundle: "stash", name: "new", content });
    expect(result.status).toBe(200);
    const read = await data(s, "/api/asset?ref=stash//knowledge/new");
    expect(read.asset.content).toContain("custom:");
    expect(read.asset.content).toContain("| one | two |");
    const before = fs.readFileSync(path.join(storage.stashDir, "knowledge", "new.md"), "utf8");
    expect(
      (await write(s, "/api/knowledge/create", { bundle: "stash", name: "new", content: "overwrite" })).status,
    ).toBe(400);
    expect(fs.readFileSync(path.join(storage.stashDir, "knowledge", "new.md"), "utf8")).toBe(before);
    expect(
      (await write(s, "/api/knowledge/create", { bundle: "stash", name: "escape", path: "../../outside", content }))
        .status,
    ).toBe(400);
    expect(
      (await write(s, "/api/knowledge/create", { bundle: "missing", name: "reject", content: "x".repeat(60_000) }))
        .status,
    ).toBe(400);
    expect((await api(s, "/api/meta")).status).toBe(200);
  });

  test("all workspace writes retain header-token, Origin, JSON and finite route guards", async () => {
    await seed();
    const s = await start();
    for (const action of [
      "feedback",
      "bundles/add",
      "bundles/remove",
      "bundles/update",
      "bundles/settings",
      "knowledge/create",
    ]) {
      const route = `/api/${action}`;
      expect((await write(s, `${route}?token=${s.token}`, {}, { "X-Akm-Ui-Token": null })).status).toBe(401);
      expect((await write(s, route, {}, { Origin: "http://attacker.invalid" })).status).toBe(403);
      expect((await write(s, route, {}, { "Content-Type": "text/plain" })).status).toBe(415);
      expect((await api(s, route)).status).toBe(404);
    }
    expect((await write(s, "/api/command", { command: "echo unsafe" })).status).toBe(405);
  });
});
