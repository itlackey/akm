// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderOutput } from "../../src/cli/shared";
import { runCliStatus as runCli } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, sandboxXdgDataHome, writeSandboxConfig } from "../_helpers/sandbox";

/** Run `fn` with `process.stdout.isTTY` set to `isTTY`, then restore it. */
async function withStdoutTTY<T>(isTTY: boolean, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process.stdout, "isTTY", original);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const stash = sandboxStashDir();
  cleanup = sandboxXdgDataHome(stash.cleanup).cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("--format json whitespace", () => {
  test("piped stdout (not a TTY) is one compact line that parses", async () => {
    const { status, stdout } = await withStdoutTTY(false, () => runCli(["log"]));
    expect(status).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toHaveProperty("events");
  });

  test("a TTY keeps the 2-space form", async () => {
    const { status, stdout } = await withStdoutTTY(true, () => runCli(["log"]));
    expect(status).toBe(0);
    expect(stdout).toContain('\n  "events"');
    expect(JSON.parse(stdout)).toHaveProperty("events");
  });

  test("--output <path> files stay pretty even when piped", async () => {
    const file = path.join(os.tmpdir(), `akm-compact-${process.pid}-${Date.now()}.json`);
    try {
      const { status } = await withStdoutTTY(false, () => runCli(["log", "--output", file]));
      expect(status).toBe(0);
      expect(fs.readFileSync(file, "utf8")).toContain('\n  "events"');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("renderOutput (src/api.ts) stays pretty unless asked for compact", () => {
    const mode = { format: "json", detail: "normal", shape: "human" } as const;
    expect(renderOutput("log-list", { events: [] }, mode)).toContain("\n");
    expect(renderOutput("log-list", { events: [] }, { ...mode, compact: true })).not.toContain("\n");
  });
});
