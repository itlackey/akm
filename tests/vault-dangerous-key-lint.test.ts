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
import {
  checkVaultForDangerousKeys,
  DANGEROUS_VAULT_KEY_PATTERNS,
  DANGEROUS_VAULT_KEYS,
  isDangerousVaultKey,
} from "../src/commands/lint/env-key-rules";
import { akmLint } from "../src/commands/lint/index";

// ── Temp dir helpers ──────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempStash(prefix = "akm-vault-lint-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// The dangerous-key lint now scans env/ (the vault type was removed in 0.9.0).
function writeVault(stashDir: string, name: string, content: string): string {
  const envDir = path.join(stashDir, "env");
  fs.mkdirSync(envDir, { recursive: true });
  const filePath = path.join(envDir, name);
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

  test("contains newly-added extended LD_* hijack vectors", () => {
    expect(DANGEROUS_VAULT_KEYS.has("LD_BIND_NOW")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("LD_PROFILE")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("LD_ASSUME_KERNEL")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("LD_TRACE_LOADED_OBJECTS")).toBe(true);
  });

  test("contains NODE_TLS_REJECT_UNAUTHORIZED (MITM enabler)", () => {
    expect(DANGEROUS_VAULT_KEYS.has("NODE_TLS_REJECT_UNAUTHORIZED")).toBe(true);
  });

  test("contains git RCE-via-invocation hijack keys", () => {
    expect(DANGEROUS_VAULT_KEYS.has("GIT_SSH_COMMAND")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("GIT_EXTERNAL_DIFF")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("GIT_PAGER")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("GIT_EDITOR")).toBe(true);
  });

  test("contains shell/startup hijack keys (IFS, ZDOTDIR, PYTHONHOME)", () => {
    expect(DANGEROUS_VAULT_KEYS.has("IFS")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("ZDOTDIR")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("PYTHONHOME")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("PYTHONNOUSERSITE")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("PYTHONINSPECT")).toBe(true);
  });

  test("contains interactive-tool invocation hijack keys (EDITOR/VISUAL/PAGER)", () => {
    // High false-positive rate — see header comment in vault-key-rules.ts.
    expect(DANGEROUS_VAULT_KEYS.has("EDITOR")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("VISUAL")).toBe(true);
    expect(DANGEROUS_VAULT_KEYS.has("PAGER")).toBe(true);
  });
});

// ── DANGEROUS_VAULT_KEY_PATTERNS / isDangerousVaultKey ────────────────────────

describe("DANGEROUS_VAULT_KEY_PATTERNS", () => {
  test("includes the BASH_FUNC_ prefix pattern (Shellshock CVE-2014-6271)", () => {
    const hit = DANGEROUS_VAULT_KEY_PATTERNS.some(({ pattern }) => pattern.test("BASH_FUNC_x%%"));
    expect(hit).toBe(true);
  });

  test("isDangerousVaultKey matches BASH_FUNC_-prefixed names", () => {
    expect(isDangerousVaultKey("BASH_FUNC_x%%")).toBe(true);
    expect(isDangerousVaultKey("BASH_FUNC_evil()")).toBe(true);
    expect(isDangerousVaultKey("BASH_FUNC_foo")).toBe(true);
  });

  test("isDangerousVaultKey does NOT match unrelated keys containing BASH_FUNC", () => {
    // pattern is anchored at start, so a key like FOO_BASH_FUNC must not match
    expect(isDangerousVaultKey("FOO_BASH_FUNC_x")).toBe(false);
    expect(isDangerousVaultKey("MY_BASH_FUNC")).toBe(false);
  });

  test("isDangerousVaultKey returns true for literal-set keys", () => {
    expect(isDangerousVaultKey("LD_PRELOAD")).toBe(true);
    expect(isDangerousVaultKey("GIT_SSH_COMMAND")).toBe(true);
  });

  test("isDangerousVaultKey returns false for benign keys", () => {
    expect(isDangerousVaultKey("API_TOKEN")).toBe(false);
    expect(isDangerousVaultKey("DATABASE_URL")).toBe(false);
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
    expect(findings[0].detail).toContain("akm env run");
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
      const m = f.detail.match(/Env key `([^`]+)`/);
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

  test("detects dangerous key with export prefix", () => {
    const stashDir = makeTempStash();
    // Vault file uses the "export KEY=value" shell form
    const vaultPath = writeVault(stashDir, "export.env", "export LD_PRELOAD=/evil.so\nSAFE=fine\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/export.env", "vault:export");

    // The LD_PRELOAD key must be detected even when prefixed with "export "
    expect(findings.length).toBeGreaterThan(0);
    const keys = findings.map((f) => {
      const m = f.detail.match(/Env key `([^`]+)`/);
      return m ? m[1] : null;
    });
    expect(keys).toContain("LD_PRELOAD");
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

  test("flags LD_BIND_NOW (extended LD_* family)", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "ld.env", "LD_BIND_NOW=1\nSAFE=ok\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/ld.env", "vault:ld");

    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("LD_BIND_NOW");
  });

  test("flags GIT_SSH_COMMAND (git RCE vector)", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "git.env", "GIT_SSH_COMMAND=/evil/ssh-wrapper.sh\nSAFE=ok\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/git.env", "vault:git");

    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("GIT_SSH_COMMAND");
  });

  test("flags NODE_TLS_REJECT_UNAUTHORIZED (MITM enabler)", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "tls.env", "NODE_TLS_REJECT_UNAUTHORIZED=0\nAPI_TOKEN=abc\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/tls.env", "vault:tls");

    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  test("flags BASH_FUNC_ prefixed keys (Shellshock pattern check)", () => {
    const stashDir = makeTempStash();
    // .env parsing rejects "()" and "%%" in keys, so we test with a clean
    // BASH_FUNC_<name> form — the pattern still matches.
    const vaultPath = writeVault(stashDir, "shock.env", "BASH_FUNC_evil=value\nSAFE=ok\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/shock.env", "vault:shock");

    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("BASH_FUNC_evil");
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
    // `result.ok` reflects "lint ran successfully", not "no findings".
    // Dangerous-vault-key findings now surface via summary.flagged; CLI
    // exit code is gated on --fail-on-flagged separately.
    expect(result.ok).toBe(true);
    expect(result.summary.flagged).toBeGreaterThan(0);
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
