// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret asset type — core module + CLI surface.
 *
 * Everything here runs in-process via the shared harness. The stdin path
 * (default `secret set` pipes the value through process.stdin, which the
 * harness cannot feed) lives in tests/integration/secret-stdin.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listNames, readValue, removeSecret, setSecret } from "../../src/commands/env/secret";
import { resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import { runCliCapture } from "../_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

// ── Core-module fixtures (tracked tmp dirs) ──────────────────────────────────

const createdTmpDirs: string[] = [];
function tmpDir(label = "secret"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

// ── CLI fixtures (sandboxed stash dirs) ──────────────────────────────────────

const disposers: SandboxedDir[] = [];
function makeStash(): string {
  const stash = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  createdTmpDirs.length = 0;
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});
afterEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});

async function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_CONFIG_DIR: undefined, ...extraEnv }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

// ── Core module ──────────────────────────────────────────────────────────────

describe("secret core module", () => {
  test("setSecret writes the file at mode 0600 and readValue returns the bytes", () => {
    const root = tmpDir();
    const fp = path.join(root, "secrets", "token");
    setSecret(fp, Buffer.from("opaque-value"));
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
    expect(readValue(fp).toString("utf8")).toBe("opaque-value");
  });

  test("multi-line / binary values round-trip byte-exact", () => {
    const root = tmpDir();
    const fp = path.join(root, "secrets", "key");
    const pem = Buffer.from("-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\n");
    setSecret(fp, pem);
    expect(readValue(fp).equals(pem)).toBe(true);

    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x00]);
    const bp = path.join(root, "secrets", "blob");
    setSecret(bp, binary);
    expect(readValue(bp).equals(binary)).toBe(true);
  });

  test("listNames returns names and excludes lock/sensitive sidecars", () => {
    const root = tmpDir();
    const secretsDir = path.join(root, "secrets");
    setSecret(path.join(secretsDir, "alpha"), Buffer.from("a"));
    setSecret(path.join(secretsDir, "team", "deploy.key"), Buffer.from("b"));
    // sidecars that must never be listed as secrets
    fs.writeFileSync(path.join(secretsDir, "alpha.sensitive"), "");
    fs.writeFileSync(path.join(secretsDir, "stale.lock"), "1");

    const names = listNames(secretsDir);
    expect(names).toContain("team/deploy.key");
    expect(names).not.toContain("alpha.sensitive");
    expect(names).not.toContain("stale.lock");
    // alpha has a sibling .sensitive marker → suppressed from listing
    expect(names).not.toContain("alpha");
  });

  test("removeSecret deletes the secret and its .sensitive marker", () => {
    const root = tmpDir();
    const fp = path.join(root, "secrets", "gone");
    setSecret(fp, Buffer.from("x"));
    fs.writeFileSync(`${fp}.sensitive`, "");
    expect(removeSecret(fp)).toBe(true);
    expect(fs.existsSync(fp)).toBe(false);
    expect(fs.existsSync(`${fp}.sensitive`)).toBe(false);
    expect(removeSecret(fp)).toBe(false);
  });

  test("setSecret recovers from a stale lock left by a dead PID", () => {
    const root = tmpDir();
    const fp = path.join(root, "secrets", "locked");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(`${fp}.lock`, "999999999");
    setSecret(fp, Buffer.from("recovered"));
    expect(readValue(fp).toString("utf8")).toBe("recovered");
    expect(fs.existsSync(`${fp}.lock`)).toBe(false);
  });
});

// ── CLI: set / list / remove ─────────────────────────────────────────────────

describe("secret set", () => {
  test("--from-file stores the file byte-exact (multi-line preserved)", async () => {
    const stashDir = makeStash();
    const src = path.join(tmpDir(), "id_ed25519");
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nline1\nline2\n-----END OPENSSH PRIVATE KEY-----\n";
    fs.writeFileSync(src, pem);

    const { status } = await runCli(["secret", "set", "secret:key", "--from-file", src], {
      AKM_STASH_DIR: stashDir,
    });
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "secrets", "key"), "utf8")).toBe(pem);
  });

  test("--from-env reads the value from the named environment variable", async () => {
    const stashDir = makeStash();
    const { status } = await runCli(["secret", "set", "secret:demo", "--from-env", "AKM_VALUE"], {
      AKM_STASH_DIR: stashDir,
      AKM_VALUE: "from-the-env",
    });
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "secrets", "demo"), "utf8")).toBe("from-the-env");
  });

  test("errors when both --from-file and --from-env are given", async () => {
    const stashDir = makeStash();
    const { status, stderr } = await runCli(
      ["secret", "set", "secret:demo", "--from-file", "/tmp/x", "--from-env", "AKM_VALUE"],
      { AKM_STASH_DIR: stashDir, AKM_VALUE: "v" },
    );
    expect(status).toBe(2);
    expect(JSON.parse(stderr.trim()).ok).toBe(false);
  });
});

describe("secret list", () => {
  test("lists names without values or paths", async () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "deploy-key"), Buffer.from("the-actual-secret-value"));

    const { stdout, status } = await runCli(["secret", "list", "--format", "json"], { AKM_STASH_DIR: stashDir });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    const refs = parsed.secrets.map((s: { ref: string }) => s.ref);
    expect(refs).toContain("secret:deploy-key");
    // No value, and no path field (stripped by the secret-list shape).
    expect(stdout).not.toContain("the-actual-secret-value");
    for (const s of parsed.secrets) expect(s.path).toBeUndefined();
  });
});

describe("secret remove", () => {
  test("removes a secret with --yes", async () => {
    const stashDir = makeStash();
    const fp = path.join(stashDir, "secrets", "demo");
    setSecret(fp, Buffer.from("v"));

    const { status } = await runCli(["secret", "remove", "secret:demo", "--yes"], { AKM_STASH_DIR: stashDir });
    expect(status).toBe(0);
    expect(fs.existsSync(fp)).toBe(false);
  });
});
