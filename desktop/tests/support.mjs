// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  assetCount = 0,
  git = false,
  configureFixture,
} = {}) {
  const fixture = await createFixture({ assetCount, git, packageRoot: appRoot });
  if (configureFixture) await configureFixture(fixture);
  if (proposals) fixture.proposals = await seedProposals(fixture);
  if (metrics) seedUsage(fixture);
  const child = fork(path.join(appRoot, "electron/server.mjs"), [], {
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
