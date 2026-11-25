// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Shutdown: the server stops accepting, lets requests and running operations finish within the grace period, then
// terminates what remains and waits for it before it exits. The operation here is a real host-tool command (a fake
// `akm` on PATH), the way software.test.mjs and the Software page run one.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createFixture } from "../scripts/fixture.mjs";
import { SHUTDOWN_BOUND_MS, SHUTDOWN_GRACE_MS, SHUTDOWN_WAIT_MS } from "../server/shutdown.mjs";

const appRoot = process.env.AKM_DESKTOP_TEST_APP_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts the server with a fake `akm` that, for `--version`, runs `body` (shell). It records its pid in `pid` and
 * appends to `ticks` every 100 ms for as long as `body` says.
 */
async function launch(t, body) {
  const fixture = await createFixture({ packageRoot: appRoot, index: false });
  t.after(() => fixture.cleanup());
  const bin = path.join(fixture.root, "fake-bin");
  await mkdir(bin);
  const ticks = path.join(fixture.root, "ticks");
  const pid = path.join(fixture.root, "pid");
  await writeFile(
    path.join(bin, "akm"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\necho $$ > "${pid}"\n${body.replaceAll("TICKS", `"${ticks}"`)}\nfi\n`,
  );
  await chmod(path.join(bin, "akm"), 0o755);
  const secret = randomBytes(32).toString("hex");
  const child = fork(path.join(appRoot, "server/server.mjs"), [], {
    execArgv: [],
    env: { ...fixture.env, AKM_WEB_SECRET: secret, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
    try {
      process.kill(-Number(await readFile(pid, "utf8")), "SIGKILL");
    } catch {
      /* gone */
    }
  });
  const ready = await new Promise((resolve, reject) => {
    exited.then((code) => reject(new Error(`Server exit ${code}: ${stderr}`)));
    child.once("message", resolve);
  });
  const response = await fetch(`${ready.origin}/api/desktop/software`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, Origin: ready.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "check" }),
  });
  assert.equal(response.status, 200, await response.text());
  for (let i = 0; i < 100 && !(await stat(ticks).catch(() => undefined)); i++) await sleep(50);
  assert.ok(await stat(ticks).catch(() => undefined), "the host tool started");
  return { child, exited, stderr: () => stderr, ticks, pid: async () => Number(await readFile(pid, "utf8")) };
}

/** Whether any process of the group is left. A killed process is only a zombie until init reaps it, so give that a moment. */
async function alive(group) {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(-group, 0);
    } catch {
      return false;
    }
    await sleep(50);
  }
  return true;
}

test("the shutdown bound covers the grace period and the termination of what remains; launchers wait longer", async () => {
  assert.ok(SHUTDOWN_BOUND_MS > SHUTDOWN_GRACE_MS);
  assert.ok(SHUTDOWN_WAIT_MS > SHUTDOWN_BOUND_MS);
  // The launchers take their wait from that one place: no timeout of their own before the force-kill.
  for (const file of ["electron/main.mjs", "tests/support.mjs"]) {
    const source = await readFile(path.join(appRoot, file), "utf8");
    assert.match(source, /import \{[^}]*SHUTDOWN_WAIT_MS[^}]*\} from "[./]*\/?(?:server\/)?shutdown\.mjs"/, file);
    assert.match(source, /\}, SHUTDOWN_WAIT_MS\)|SIGKILL"\), SHUTDOWN_WAIT_MS\)/, file);
  }
});

test("a host tool still running after the grace period is terminated before the server exits", async (t) => {
  const app = await launch(t, `while :; do echo x >> TICKS; sleep 0.1; done`);
  const group = await app.pid();
  app.child.kill("SIGTERM");
  const code = await app.exited;
  assert.equal(code, 0);
  assert.equal(await alive(group), false, "no process of the tool's group is left");
  const size = (await stat(app.ticks)).size;
  await sleep(500);
  assert.equal((await stat(app.ticks)).size, size, "nothing writes after the server exited");
  const lines = app
    .stderr()
    .split("\n")
    .filter((line) => /stopped/i.test(line));
  assert.equal(lines.length, 1, app.stderr());
  assert.match(lines[0], /akm/);
});

test("a host tool that ignores SIGTERM is killed within the bound", async (t) => {
  const app = await launch(t, `trap '' TERM\nwhile :; do echo x >> TICKS; sleep 0.1; done`);
  const group = await app.pid();
  const started = Date.now();
  app.child.kill("SIGTERM");
  assert.equal(await app.exited, 0);
  assert.ok(Date.now() - started < SHUTDOWN_BOUND_MS + 2000, "within the shared bound");
  assert.equal(await alive(group), false);
});

test("an operation that finishes within the grace period is allowed to finish", async (t) => {
  const app = await launch(
    t,
    `for i in 1 2 3 4 5 6 7 8; do echo x >> TICKS; sleep 0.1; done\necho done >> TICKS\necho 0.1.0`,
  );
  const group = await app.pid();
  app.child.kill("SIGTERM");
  assert.equal(await app.exited, 0);
  assert.equal(await alive(group), false);
  assert.match(await readFile(app.ticks, "utf8"), /done\n$/, "it ran to the end");
  assert.doesNotMatch(app.stderr(), /stopped/i);
});

/**
 * Runs `body` in a fresh Node process that tracks its children the way the server does. `body` gets the exports of
 * shutdown.mjs, akm-cli's recorded `spawn` and a `sleep`; what it returns comes back with the process's stderr. The process has
 * `WRITER` (a script that ignores SIGTERM and appends to `TICKS` every 100 ms), `TICKS` and `PIDFILE` in its environment.
 */
async function probe(t, body) {
  const dir = await mkdtemp(path.join(tmpdir(), "akm-shutdown-"));
  const env = {
    ...process.env,
    WRITER: path.join(dir, "writer"),
    TICKS: path.join(dir, "ticks"),
    PIDFILE: path.join(dir, "pid"),
  };
  t.after(async () => {
    try {
      process.kill(Number(await readFile(env.PIDFILE, "utf8")), "SIGKILL");
    } catch {
      /* gone */
    }
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    env.WRITER,
    `#!/bin/sh\ntrap '' TERM\necho $$ > "$PIDFILE"\nwhile :; do echo x >> "$TICKS"; sleep 0.1; done\n`,
  );
  await chmod(env.WRITER, 0o755);
  const source = `
    import { children } from "akm-cli/workspace";
    import * as shutdown from ${JSON.stringify(pathToFileURL(path.join(appRoot, "server/shutdown.mjs")).href)};
    shutdown.track(children);
    const spawn = children.spawnChild;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    console.log(JSON.stringify(await (${body})(shutdown, spawn, sleep)));
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], {
    env,
    cwd: appRoot,
  });
  return { ...JSON.parse(stdout), stderr, ticks: env.TICKS };
}

/** Whether anything still appends to `file`. */
async function written(file) {
  const size = (await stat(file)).size;
  await sleep(500);
  return (await stat(file)).size > size;
}

/** Starts a shell that starts the writer, then waits for it (`wait`) or exits at once; terminates once the writer writes. */
const tree = (detached, shell) => `async (shutdown, spawn, sleep) => {
  const { existsSync } = await import("node:fs");
  const child = spawn("sh", ["-c", ${JSON.stringify(shell)}], { detached: ${detached}, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (${!shell.includes("wait")}) await exited;
  while (!existsSync(process.env.TICKS)) await sleep(25);
  const started = Date.now();
  await shutdown.terminate();
  return { ms: Date.now() - started };
}`;

const posix = { skip: process.platform === "win32" };

test("a grandchild that ignores SIGTERM is stopped after its group leader exits on SIGTERM", posix, async (t) => {
  const result = await probe(t, tree(true, `"$WRITER" & wait`));
  assert.equal(await written(result.ticks), false, "nothing writes after terminate() returned");
  assert.ok(result.ms < SHUTDOWN_BOUND_MS - SHUTDOWN_GRACE_MS + 500, `terminate() took ${result.ms} ms`);
  assert.match(result.stderr, /stopped sh/);
});

test("what a child left running when it exited before shutdown is stopped", posix, async (t) => {
  const result = await probe(t, tree(true, `"$WRITER" &`));
  assert.equal(await written(result.ticks), false, "nothing writes after terminate() returned");
  assert.match(result.stderr, /stopped sh/);
});

test("the tree of a child that was not started detached is stopped", posix, async (t) => {
  const result = await probe(t, tree(false, `"$WRITER" & wait`));
  assert.equal(await written(result.ticks), false, "nothing writes after terminate() returned");
  const left = await probe(t, tree(false, `"$WRITER" &`));
  assert.equal(await written(left.ticks), false, "nor when the child exited before shutdown");
});

// An operation that is stopped moves on to its next command (Software's check runs one program after another). What it
// starts once termination has begun is stopped too, so the server never exits with a child of its own still running.
test("a command an operation starts while it is being terminated is stopped", posix, async (t) => {
  const result = await probe(
    t,
    `async (shutdown, spawn, sleep) => {
        const { existsSync } = await import("node:fs");
        let started = 0;
        const next = () => {
          started++;
          // Unreferenced, so a writer left running fails the assertions below instead of holding this process open.
          const child = spawn(process.env.WRITER, [], { stdio: "ignore" });
          child.unref();
          child.once("exit", () => {
            if (started < 3) next();
          });
        };
        next();
        while (!existsSync(process.env.TICKS)) await sleep(25);
        await shutdown.terminate();
        return { started };
      }`,
  );
  assert.equal(result.started, 3, "the operation started its next commands during termination");
  assert.equal(await written(result.ticks), false, "nothing writes after terminate() returned");
  assert.doesNotMatch(result.stderr, /could not stop/);
});

// A process that has exited stays in its group until its parent waits for it. Where that never happens (a container
// whose first process does not reap), such a group must not hold up every shutdown.
test("a group holding only a process nobody waited for does not count as running", {
  skip: process.platform !== "linux",
}, async (t) => {
  // The leader exits; its child starts one that exits at once, never waits for it, and leaves the group.
  const perl = `use POSIX; exit 0 if fork; exit 0 if !fork; POSIX::setsid(); open(F, ">", $ENV{PIDFILE}); print F $$; close F; sleep 30`;
  const result = await probe(
    t,
    `async (shutdown, spawn, sleep) => {
        const { existsSync } = await import("node:fs");
        const child = spawn("perl", ["-e", ${JSON.stringify(perl)}], { detached: true, stdio: "ignore" });
        const group = child.pid;
        await new Promise((resolve) => child.once("exit", resolve));
        while (!existsSync(process.env.PIDFILE)) await sleep(25);
        await sleep(100);
        let members = true;
        try { process.kill(-group, 0); } catch { members = false; }
        const started = Date.now();
        await shutdown.drained(2000);
        await shutdown.terminate();
        return { members, ms: Date.now() - started };
      }`,
  );
  assert.equal(result.members, true, "the group still has its unreaped member");
  assert.ok(result.ms < 1000, `shutdown waited ${result.ms} ms for it`);
  assert.equal(result.stderr, "");
});
