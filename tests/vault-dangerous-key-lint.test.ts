/**
 * Tests for the vault dangerous-key lint rule.
 *
 * Verifies that:
 *   1. A vault file containing a known-dangerous key (e.g. LD_PRELOAD) produces
 *      a `dangerous-vault-key` finding when akmLint is run.
 *   2. Multiple dangerous keys each produce their own finding.
 *   3. A vault file with only safe keys produces no dangerous-vault-key findings.
 *   4. The checkVaultForDangerousKeys helper works correctly in isolation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import { checkVaultForDangerousKeys, DANGEROUS_VAULT_KEYS } from "../src/commands/lint/vault-key-rules";

// ── Temp dir helpers ──────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempStash(prefix = "akm-vault-lint-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeVault(stashDir: string, name: string, content: string): string {
  const vaultsDir = path.join(stashDir, "vaults");
  fs.mkdirSync(vaultsDir, { recursive: true });
  const filePath = path.join(vaultsDir, name);
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── DANGEROUS_VAULT_KEYS ──────────────────────────────────────────────────────

describe("DANGEROUS_VAULT_KEYS", () => {
  test("contains expected linker hijack keys", () => {
    expect(DANGEROUS_VAULT_KEYS.has("LD_PRELOAD")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("LD_LIBRARY_PATH")).toBe(true);
  });

  test("contains expected shell/path keys", () => {
    expect(DANGEROUS_VAULT_KEYS.has("PATH")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("BASH_ENV")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("PROMPT_COMMAND")).toBe(true);
  });

  test("contains expected runtime hijack keys", () => {
    expect(DANGEROUS_VAULT_KEYS.has("NODE_OPTIONS")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("PYTHONSTARTUP")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("JAVA_TOOL_OPTIONS")).toBe(true);
  });

  test("does NOT contain benign env vars", () => {
    expect(DANGEROUS_VAULT_KEYS.has("MY_APP_SECRET")).toBe(false);
    expect(DANGEROUS_VAULT_KEYS.has("DATABASE_URL")).toBe(false);
    expect(DANGEROUS_VAULT_KEYS.has("API_TOKEN")).toBe(false);
  });
});

// ── checkVaultForDangerousKeys (unit) ─────────────────────────────────────────

describe("checkVaultForDangerousKeys", () => {
  test("returns a finding for LD_PRELOAD", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, ".env", "LD_PRELOAD=/evil/lib.so\nDB_URL=postgres://safe\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/.env", "vault:default");

    expect(findings).toHaveLength(1);
    expect(findings[0].issue).toBe("dangerous-vault-key");
    expect(findings[0].file).toBe("vaults/.env");
    expect(findings[0].detail).toContain("LD_PRELOAD");
    expect(findings[0].detail).toContain("akm vault run");
    expect(findings[0].fixed).toBe(false);
  });

  test("returns one finding per dangerous key", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(
      stashDir,
      "prod.env",
      [
        "LD_PRELOAD=/evil/lib.so",
        "NODE_OPTIONS=--require /evil/hook.js",
        "PATH=/evil/bin:/usr/bin",
        "MY_SECRET=innocent",
      ].join("\n"),
    );
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/prod.env", "vault:prod");

    expect(findings).toHaveLength(3);
    const keys = findings.map((f) => {
      const m = f.detail.match(/Vault key `([^`]+)`/);
      return m ? m[1] : null;
    });
    expect(keys).toContain("LD_PRELOAD");
    expect(keys).toContain("NODE_OPTIONS");
    expect(keys).toContain("PATH");
  });

  test("returns no findings for a safe vault file", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "safe.env", "API_KEY=abc123\nDB_HOST=localhost\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/safe.env", "vault:safe");

    expect(findings).toHaveLength(0);
  });

  test("returns no findings for a non-existent vault file", () => {
    const stashDir = makeTempStash();
    const vaultPath = path.join(stashDir, "vaults", "missing.env");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/missing.env", "vault:missing");

    expect(findings).toHaveLength(0);
  });

  test("includes vault ref in the finding detail", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "staging.env", "BASH_ENV=/evil/rc\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/staging.env", "vault:staging");

    expect(findings[0].detail).toContain("vault:staging");
  });
});

// ── akmLint integration ───────────────────────────────────────────────────────

describe("akmLint dangerous-vault-key integration", () => {
  test("flags a vault file containing LD_PRELOAD", () => {
    const stashDir = makeTempStash();
    writeVault(stashDir, ".env", "LD_PRELOAD=/evil/lib.so\nSAFE_KEY=ok\n");

    const result = akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-vault-key");
    expect(dangerous).toHaveLength(1);
    expect(dangerous[0].detail).toContain("LD_PRELOAD");
    expect(dangerous[0].file).toContain(".env");
    expect(result.ok).toBe(false);
  });

  test("flags each dangerous key in a vault file separately", () => {
    const stashDir = makeTempStash();
    writeVault(
      stashDir,
      "attack.env",
      ["DYLD_INSERT_LIBRARIES=/evil.dylib", "NODE_OPTIONS=--require evil", "SAFE_KEY=fine"].join("\n"),
    );

    const result = akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-vault-key");
    expect(dangerous).toHaveLength(2);
  });

  test("does not flag a vault file with only safe keys", () => {
    const stashDir = makeTempStash();
    writeVault(stashDir, "clean.env", "API_TOKEN=abc\nDB_URL=postgres://localhost/db\n");

    const result = akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-vault-key");
    expect(dangerous).toHaveLength(0);
  });

  test("scans multiple vault files in the same stash", () => {
    const stashDir = makeTempStash();
    writeVault(stashDir, "prod.env", "LD_PRELOAD=/evil.so\n");
    writeVault(stashDir, "dev.env", "SAFE=ok\n");
    writeVault(stashDir, "staging.env", "PATH=/evil:/usr/bin\n");

    const result = akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-vault-key");
    // One finding from prod.env (LD_PRELOAD) + one from staging.env (PATH)
    expect(dangerous).toHaveLength(2);
  });

  test("does not produce dangerous-vault-key findings when vaults/ dir is absent", () => {
    const stashDir = makeTempStash();
    // No vaults/ dir at all

    const result = akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-vault-key");
    expect(dangerous).toHaveLength(0);
  });
});
