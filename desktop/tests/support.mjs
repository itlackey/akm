import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createFixture } from "../scripts/fixture.mjs";

export const root = fileURLToPath(new URL("..", import.meta.url));
const appRoot = process.env.AKM_DESKTOP_TEST_APP_ROOT ?? root;
export async function launchFixture({
  proposals = false,
  metrics = false,
  assetCount = 0,
  git = false,
  configureFixture,
} = {}) {
  const fixture = await createFixture({ assetCount, git, packageRoot: appRoot });
  if (configureFixture) await configureFixture(fixture);
  if (proposals) {
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("./seed-proposals.mjs", import.meta.url))], {
      env: { ...fixture.env, AKM_DESKTOP_TEST_ROOT: fixture.root },
      encoding: "utf8",
      timeout: 60000,
    });
    fixture.proposals = JSON.parse(output.trim().split("\n").at(-1));
  }
  if (metrics)
    execFileSync(process.execPath, [fileURLToPath(new URL("./seed-metrics.mjs", import.meta.url))], {
      env: { ...fixture.env, AKM_DESKTOP_TEST_ROOT: fixture.root },
      encoding: "utf8",
      timeout: 60000,
    });
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
