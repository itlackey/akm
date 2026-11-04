// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createFixture } from "../scripts/fixture.mjs";

export const root = fileURLToPath(new URL("..", import.meta.url));
const appRoot = process.env.AKM_DESKTOP_TEST_APP_ROOT ?? root;
const read = (file) => readFile(file, "utf8");
/** Run the CLI against a fixture; returns its JSON result. */
export function akm(fixture, args, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [fixture.launcher, ...args, "--format", "json", "-q"], {
    env: { ...fixture.env, ...extraEnv },
    encoding: "utf8",
    timeout: 60000,
  });
  return JSON.parse(stdout);
}

/** Queue a pending proposal through the CLI. A stand-in agent returns `content`; no model runs. */
async function propose(fixture, name, content) {
  const reply = path.join(fixture.root, `reply-${name}.json`);
  await writeFile(reply, JSON.stringify({ ref: `knowledge/${name}`, content }));
  return akm(fixture, ["proposal", "new", "knowledge", name, "--task", "synthetic", "--harness", "fake"], {
    AKM_FIXTURE_REPLY: reply,
  }).proposal.id;
}

const document = (title, body) =>
  `---\ntitle: ${title}\ndescription: Synthetic desktop acceptance test guidance\n---\n# ${title}\n\n${body}\n`;

async function seedProposals(fixture) {
  const note = await read(fixture.documentPath);
  return {
    stale: await propose(fixture, "restore-laptop", note.replace("checksum", "checksum and available space")),
    fresh: await propose(
      fixture,
      "recovery-checklist",
      document(
        "Recovery checklist",
        "Confirm the intended target disk before restoring. Preserve the original backup and verify its checksum. After restoring, verify that the new system boots and that the restored files can be opened. Record any failures before retrying.",
      ),
    ),
    reject: await propose(
      fixture,
      "review-example",
      document(
        "Review example",
        "This document is a synthetic proposal used to test manual rejection and reopening. Its contents have no authority over any real installation. A reviewer can inspect the proposed source, reject it with a reason, and reopen it without changing another document.",
      ),
    ),
  };
}

/** Real usage events from the CLI: searches (one with no result), a show, and feedback in both directions. */
function seedUsage(fixture) {
  for (const query of ["backup", "backup", "backup", "missing restore steps"]) akm(fixture, ["search", query]);
  akm(fixture, ["show", fixture.refs.document]);
  akm(fixture, ["feedback", fixture.refs.document, "--positive"]);
  akm(fixture, ["feedback", fixture.refs.memory, "--negative", "--reason", "Synthetic review evidence"]);
}

/**
 * Recorded runs, which no CLI command creates without a scheduler or a model: one failed task run and one improve run,
 * written into the state database the CLI made.
 */
function seedRuns(fixture) {
  const db = new DatabaseSync(path.join(fixture.env.AKM_DATA_DIR, "state.db"));
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  try {
    db.prepare(
      "INSERT INTO task_history (task_id, status, started_at, failed_at, target_kind, target_ref, metadata_json) VALUES (?, 'failed', ?, ?, 'agent', ?, ?)",
    ).run(
      "synthetic-failure",
      at(10),
      at(9),
      "personal//agents/recovery-reviewer",
      JSON.stringify({
        metadataVersion: 2,
        durationMs: 60000,
        detail: { reason: "timeout", error: "Synthetic timeout: no network request was made.", exitCode: 1 },
      }),
    );
    db.prepare(
      "INSERT INTO improve_runs (id, started_at, completed_at, stash_dir, scope_mode, ok, strategy, result_json) VALUES (?, ?, ?, ?, 'all', 1, 'default', ?)",
    ).run(
      "synthetic-improve",
      at(30),
      at(29),
      fixture.env.AKM_BUNDLE_DIR,
      JSON.stringify({
        usageReport: { byProcessEngineModel: [{ process: "reflect", calls: 3, failures: 0 }] },
        triage: { promoted: 2, rejected: 1, failed: 0 },
      }),
    );
  } finally {
    db.close();
  }
}

/** Stored embeddings for two documents, so Similar content has a match to score (no embedding model runs). */
function seedSimilarity(fixture) {
  const db = new DatabaseSync(path.join(fixture.env.AKM_DATA_DIR, "index.db"));
  try {
    db.prepare("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('embeddingFingerprint', 'fixture')").run();
    for (const [ref, vector] of [
      [fixture.refs.document, [1, 0]],
      [fixture.refs.shared, [0.9, 0.1]],
    ]) {
      const { id } = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get(ref);
      db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding, model) VALUES (?, ?, 'fixture')").run(
        id,
        Buffer.from(new Float32Array(vector).buffer),
      );
    }
  } finally {
    db.close();
  }
}

/**
 * Open the app the way the launcher does (the one-time session URL sets the cookie), then optionally go to a route.
 * `go` navigates inside the running app, so drafts and in-memory state survive, as a click on a link would.
 */
export async function open(page, server, route) {
  await page.goto(server.url);
  if (route && route !== "/") await page.goto(server.origin + route);
}
export function go(page, href) {
  return page.evaluate((href) => {
    const link = document.createElement("a");
    link.href = href;
    document.body.append(link);
    link.click();
    link.remove();
  }, href);
}

export async function launchFixture({
  proposals = false,
  metrics = false,
  similarity = false,
  assetCount = 0,
  git = false,
  configureFixture,
} = {}) {
  const fixture = await createFixture({ assetCount, git, packageRoot: appRoot });
  if (configureFixture) await configureFixture(fixture);
  if (proposals) fixture.proposals = await seedProposals(fixture);
  if (metrics) {
    seedUsage(fixture);
    seedRuns(fixture);
  }
  if (similarity) seedSimilarity(fixture);
  const child = fork(path.join(appRoot, "server/server.mjs"), [], {
    env: fixture.env,
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let logs = "";
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  async function stop() {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      if (child.connected) child.send("shutdown");
      else child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
      await exited;
      clearTimeout(timer);
    }
    await fixture.cleanup();
  }
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 45000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}: ${logs}`));
      });
      child.on("message", (message) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    const bootstrap = await fetch(ready.url, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const setCookie = bootstrap.headers.get("set-cookie");
    assert.ok(setCookie, `Session bootstrap must set a cookie. ${logs}`);
    const cookie = setCookie.split(";")[0];
    const call = async (pathname, body) => {
      const response = await fetch(`${ready.origin}${pathname}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie,
          ...(body === undefined ? {} : { origin: ready.origin, "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    return {
      ...fixture,
      ...ready,
      child,
      call,
      cookie,
      logs: () => logs,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
