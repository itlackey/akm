// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An index akm cannot READ is not an index that does not exist (issue #791).
 *
 * `fs.existsSync()` returns `false` for `EACCES` exactly as it does for
 * `ENOENT`, and the read path used it as its "is there an index?" gate. So a
 * populated index the caller lacked permission on produced
 * `{ hits: [], tip: "No search index available. Run 'akm index' to build one." }`
 * at **exit 0** — a false statement, delivered as a success, with no way for a
 * machine caller to tell it from a genuine empty result. The failure that
 * prompted this reached a user as an AI agent's invented explanation ("its
 * vector service is unavailable and its maintenance lock is read-only")
 * precisely because akm told the agent everything was fine.
 *
 * ## On making a path unreadable in a test
 *
 * `chmod 0000` does nothing for uid 0, and this suite runs as root in
 * containers, so a chmod-only test would silently skip in exactly the
 * environment CI uses. A **symlink loop** raises `ELOOP` for every uid, root
 * included, so it is the primary technique here; the chmod cases run too
 * wherever permission bits are actually enforced.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../src/commands/health";
import { ConfigError } from "../../src/core/errors";
import { probeLock } from "../../src/core/file-lock";
import { classifyPathAccess, describeInaccessiblePath } from "../../src/core/path-access";
import { openExistingDatabase, openReadonlyExistingDatabase } from "../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { enforcesPermissionBits, makeUnresolvablePath } from "../_helpers/unreadable-path";

describe("classifyPathAccess (#791)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("absent, present and inaccessible are three distinct answers", () => {
    storage = withIsolatedAkmStorage();

    expect(classifyPathAccess(path.join(storage.root, "never-created.db")).access).toBe("absent");

    const real = path.join(storage.root, "real.db");
    fs.writeFileSync(real, "sqlite");
    expect(classifyPathAccess(real).access).toBe("present");

    const looping = makeUnresolvablePath(storage.root, "loop.db");
    const classified = classifyPathAccess(looping);
    expect(classified.access).toBe("inaccessible");
    expect(classified.code).toBe("ELOOP");
    // The distinction the bug turned on: existsSync cannot tell these apart.
    expect(fs.existsSync(looping)).toBe(false);
    expect(fs.existsSync(path.join(storage.root, "never-created.db"))).toBe(false);
  });

  test.skipIf(!enforcesPermissionBits)("an unreadable file is inaccessible, not absent", () => {
    storage = withIsolatedAkmStorage();
    const locked = path.join(storage.root, "locked.db");
    fs.writeFileSync(locked, "sqlite");
    fs.chmodSync(locked, 0o000);
    try {
      expect(classifyPathAccess(locked).access).toBe("inaccessible");
      expect(fs.existsSync(locked)).toBe(true); // existsSync is no help here either
    } finally {
      fs.chmodSync(locked, 0o644);
    }
  });

  test("the diagnostic names the path, the errno and the running uid", () => {
    storage = withIsolatedAkmStorage();
    const looping = makeUnresolvablePath(storage.root, "loop.db");
    const detail = describeInaccessiblePath(looping, classifyPathAccess(looping).code);

    expect(detail).toContain(looping);
    expect(detail).toContain("ELOOP");
    if (typeof process.getuid === "function") expect(detail).toContain(`uid ${process.getuid()}`);
  });
});

describe("the index openers refuse to call an unreadable index missing (#791)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("openReadonlyExistingDatabase raises rather than returning undefined", () => {
    storage = withIsolatedAkmStorage();
    const looping = makeUnresolvablePath(storage.root, "index.db");

    // `undefined` is this function's "no index" answer — it must stay reserved
    // for a genuinely absent one.
    expect(() => openReadonlyExistingDatabase(looping)).toThrow(ConfigError);
    expect(openReadonlyExistingDatabase(path.join(storage.root, "absent.db"))).toBeUndefined();
  });

  test("openExistingDatabase reports unreadable, not \"run 'akm index'\"", () => {
    storage = withIsolatedAkmStorage();
    const looping = makeUnresolvablePath(storage.root, "index.db");

    let raised: unknown;
    try {
      openExistingDatabase(looping);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(ConfigError);
    expect((raised as ConfigError).code).toBe("DATA_DIR_UNREADABLE");
    // Telling the user to build an index they cannot read would not help them.
    expect((raised as Error).message).not.toMatch(/Run 'akm index'/);
    expect((raised as Error).message).toMatch(/not readable/);
  });
});

describe("probeLock separates 'cannot read' from 'holder is dead' (#791)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test.skipIf(!enforcesPermissionBits)("an unreadable sentinel is inaccessible, never stale", () => {
    storage = withIsolatedAkmStorage();
    const lockPath = path.join(storage.root, "improve.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    fs.chmodSync(lockPath, 0o000);

    try {
      const probe = probeLock(lockPath);
      // "stale" would invite reclaimStaleLock to steal a possibly-live lease.
      expect(probe.state).toBe("inaccessible");
      expect(probe.state === "inaccessible" && probe.code).toBe("EACCES");
    } finally {
      fs.chmodSync(lockPath, 0o644);
    }
  });

  test("an absent lock is still absent, and a readable one is still classified normally", () => {
    storage = withIsolatedAkmStorage();
    const lockPath = path.join(storage.root, "improve.lock");
    expect(probeLock(lockPath).state).toBe("absent");

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    expect(probeLock(lockPath).state).toBe("held");
  });
});

describe("akm health diagnoses an unreadable state.db instead of dying on it (#791)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test("returns a failing report naming the path, rather than throwing", async () => {
    storage = withIsolatedAkmStorage();
    const looping = makeUnresolvablePath(storage.root, "state.db");

    // Previously this threw ConfigError (exit 78) from the state.db open, so the
    // one command able to explain a data-dir permission fault could not run.
    const result = await akmHealth({ stateDbPath: looping, stashDir: storage.stashDir });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("fail");
    const finding = result.hardChecks.find((c) => c.name === "state-db-readable");
    expect(finding).toBeDefined();
    expect(finding?.status).toBe("fail");
    expect(finding?.message).toContain(looping);
    expect(finding?.message).toContain("ELOOP");
  });
});
