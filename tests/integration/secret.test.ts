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
import { readSecret } from "../../src/core/env-secret-ref";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import { runCliCapture } from "../_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";
import { writeSecretFile } from "../_helpers/secret-file";

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
});
afterEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
});

async function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_CONFIG_DIR: undefined, ...extraEnv }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

// ── Stored and read values ───────────────────────────────────────────────────

describe("secret values", () => {
  test("a secret set from a file is stored byte-exact at mode 0600, and read back trimmed", async () => {
    const stashDir = makeStash();
    const src = path.join(tmpDir(), "pem");
    const pem = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\n";
    fs.writeFileSync(src, pem);
    expect(
      (await runCli(["secret", "set", "secrets/key", "--from-file", src], { AKM_BUNDLE_DIR: stashDir })).status,
    ).toBe(0);

    const fp = path.join(stashDir, "secrets", "key");
    expect(fs.readFileSync(fp, "utf8")).toBe(pem);
    if (process.platform !== "win32") expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      expect(readSecret("secrets/key").value).toBe("-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----");
    });
  });

  test("binary values are stored byte-exact", async () => {
    const stashDir = makeStash();
    const src = path.join(tmpDir(), "blob");
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x00]);
    fs.writeFileSync(src, binary);
    expect(
      (await runCli(["secret", "set", "secrets/blob", "--from-file", src], { AKM_BUNDLE_DIR: stashDir })).status,
    ).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "secrets", "blob")).equals(binary)).toBe(true);
  });

  test("a hand-written value's surrounding whitespace is never part of the secret", async () => {
    const stashDir = makeStash();
    writeSecretFile(path.join(stashDir, "secrets", "padded"), "  token-value \r\n\n");
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      expect(readSecret("secrets/padded").value).toBe("token-value");
    });
  });

  test("setting a secret leaves nothing but the secret in the bundle", async () => {
    const stashDir = makeStash();
    await runCli(["secret", "set", "secrets/plain", "--from-env", "AKM_VALUE"], {
      AKM_BUNDLE_DIR: stashDir,
      AKM_VALUE: "v",
    });
    expect(fs.readdirSync(path.join(stashDir, "secrets"))).toEqual(["plain"]);
  });
});

// ── CLI: set / list / remove ─────────────────────────────────────────────────

describe("secret set", () => {
  test("--from-file stores the file byte-exact (multi-line preserved)", async () => {
    const stashDir = makeStash();
    const src = path.join(tmpDir(), "id_ed25519");
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nline1\nline2\n-----END OPENSSH PRIVATE KEY-----\n";
    fs.writeFileSync(src, pem);

    const { status } = await runCli(["secret", "set", "secrets/key", "--from-file", src], {
      AKM_BUNDLE_DIR: stashDir,
    });
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "secrets", "key"), "utf8")).toBe(pem);
  });

  test("--from-env reads the value from the named environment variable", async () => {
    const stashDir = makeStash();
    const { status } = await runCli(["secret", "set", "secrets/demo", "--from-env", "AKM_VALUE"], {
      AKM_BUNDLE_DIR: stashDir,
      AKM_VALUE: "from-the-env",
    });
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(stashDir, "secrets", "demo"), "utf8")).toBe("from-the-env");
  });

  test("errors when both --from-file and --from-env are given", async () => {
    const stashDir = makeStash();
    const { status, stderr } = await runCli(
      ["secret", "set", "secrets/demo", "--from-file", "/tmp/x", "--from-env", "AKM_VALUE"],
      { AKM_BUNDLE_DIR: stashDir, AKM_VALUE: "v" },
    );
    expect(status).toBe(2);
    expect(JSON.parse(stderr.trim()).ok).toBe(false);
  });
});

describe("secret list", () => {
  test("lists names without values or paths", async () => {
    const stashDir = makeStash();
    writeSecretFile(path.join(stashDir, "secrets", "deploy-key"), Buffer.from("the-actual-secret-value"));

    const { stdout, status } = await runCli(["secret", "list", "--format", "json"], { AKM_BUNDLE_DIR: stashDir });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    const refs = parsed.secrets.map((s: { ref: string }) => s.ref);
    expect(refs).toContain("secrets/deploy-key");
    // No value, and no path field (stripped by the secret-list shape).
    expect(stdout).not.toContain("the-actual-secret-value");
    for (const s of parsed.secrets) expect(s.path).toBeUndefined();
  });
});

// `akm secret remove` was removed in 0.9.0 (R-027 / D-49) and is back, shaped like `akm env remove`.
describe("secret remove", () => {
  test("removes the secret file and its .sensitive marker, and reports it", async () => {
    const stashDir = makeStash();
    const fp = path.join(stashDir, "secrets", "demo");
    writeSecretFile(fp, Buffer.from("topsecret-value"));
    fs.writeFileSync(`${fp}.sensitive`, "");

    const { stdout, status } = await runCli(["secret", "remove", "secrets/demo", "--yes", "--format", "json"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ shape: "secret-remove", removed: true });
    expect(JSON.parse(stdout).ref).toEndWith("//secrets/demo");
    expect(stdout).not.toContain("topsecret-value");
    expect(fs.existsSync(fp)).toBe(false);
    expect(fs.existsSync(`${fp}.sensitive`)).toBe(false);
  });

  test("a secret that does not exist is a not-found error and nothing else is touched", async () => {
    const stashDir = makeStash();
    const other = path.join(stashDir, "secrets", "other");
    writeSecretFile(other, Buffer.from("v"));

    const { stderr, status } = await runCli(["secret", "remove", "secrets/demo", "--yes"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(status).toBe(1);
    expect(JSON.parse(stderr).code).toBe("ASSET_NOT_FOUND");
    expect(fs.existsSync(other)).toBe(true);
  });

  test("refuses to delete without --yes when not interactive", async () => {
    const stashDir = makeStash();
    const fp = path.join(stashDir, "secrets", "demo");
    writeSecretFile(fp, Buffer.from("v"));

    const { status } = await runCli(["secret", "remove", "secrets/demo"], { AKM_BUNDLE_DIR: stashDir });

    expect(status).not.toBe(0);
    expect(fs.existsSync(fp)).toBe(true);
  });
});

describe("secret slash ref form", () => {
  test("the slash form `secrets/<name>` still resolves normally", async () => {
    // Uses `secret set` (not `secret run`) for this positive-resolution check:
    // `secret run`'s success path ends in an unconditional `process.exit`,
    // which the in-process test harness's exit shim converts into a thrown
    // "error" that `runWithJsonErrors` re-wraps as a JSON envelope — a
    // pre-existing harness limitation unrelated to ref resolution (see
    // tests/integration/secret-run.test.ts's docstring on why its happy path
    // requires a real subprocess). `secret set` exercises the identical
    // parseSecretRef resolution without that exit call.
    const stashDir = makeStash();
    const fp = path.join(stashDir, "secrets", "deploy-key");
    writeSecretFile(fp, Buffer.from("v"));

    const { status } = await runCli(["secret", "set", "secrets/deploy-key", "--from-env", "AKM_VALUE"], {
      AKM_BUNDLE_DIR: stashDir,
      AKM_VALUE: "updated-value",
    });

    expect(status).toBe(0);
    expect(fs.readFileSync(fp, "utf8")).toBe("updated-value");
  });
});
