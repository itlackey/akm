// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the 0.9.0 un-migrated `vaults/` guard.
 *
 * The guard is read-only: it must never read .env contents, write, or delete.
 * It emits a one-time warning when a stash has `vaults/` with .env files but no
 * `.migrated` marker (the state a 0.7/0.8 → 0.9 upgrade leaves if the storage
 * migration was never run).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  _resetUnmigratedVaultsGuardForTests,
  warnOnUnmigratedVaults,
} from "../../src/indexer/usage/unmigrated-vaults-guard";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "akm-vaults-guard-"));
  _resetUnmigratedVaultsGuardForTests();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  _resetUnmigratedVaultsGuardForTests();
});

describe("warnOnUnmigratedVaults", () => {
  test("warns when vaults/ has .env files and no .migrated marker", () => {
    fs.mkdirSync(path.join(tmp, "vaults", "team"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "vaults", "prod.env"), "API_KEY=secret\n");
    fs.writeFileSync(path.join(tmp, "vaults", "team", "dev.env"), "TOKEN=x\n");

    expect(warnOnUnmigratedVaults(tmp)).toBe(true);
  });

  test("is idempotent — only warns once per stash per process", () => {
    fs.mkdirSync(path.join(tmp, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "vaults", "prod.env"), "API_KEY=secret\n");

    expect(warnOnUnmigratedVaults(tmp)).toBe(true);
    expect(warnOnUnmigratedVaults(tmp)).toBe(false);
  });

  test("does not warn when the .migrated marker is present", () => {
    fs.mkdirSync(path.join(tmp, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "vaults", "prod.env"), "API_KEY=secret\n");
    fs.writeFileSync(path.join(tmp, "vaults", ".migrated"), "done\n");

    expect(warnOnUnmigratedVaults(tmp)).toBe(false);
  });

  test("does not warn when there is no vaults/ directory", () => {
    expect(warnOnUnmigratedVaults(tmp)).toBe(false);
  });

  test("does not warn for an empty vaults/ (no .env files)", () => {
    fs.mkdirSync(path.join(tmp, "vaults"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "vaults", "README.md"), "notes\n");

    expect(warnOnUnmigratedVaults(tmp)).toBe(false);
  });

  test("is non-destructive — leaves vaults/ contents untouched", () => {
    fs.mkdirSync(path.join(tmp, "vaults"), { recursive: true });
    const file = path.join(tmp, "vaults", "prod.env");
    fs.writeFileSync(file, "API_KEY=secret\n");

    warnOnUnmigratedVaults(tmp);

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("API_KEY=secret\n");
    // No marker is written by the guard (only the migration writes it).
    expect(fs.existsSync(path.join(tmp, "vaults", ".migrated"))).toBe(false);
  });
});
