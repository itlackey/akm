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
  checkEnvForDangerousKeys as checkVaultForDangerousKeys,
  DANGEROUS_ENV_KEY_PATTERNS as DANGEROUS_VAULT_KEY_PATTERNS,
  DANGEROUS_ENV_KEYS as DANGEROUS_VAULT_KEYS,
  isDangerousEnvKey as isDangerousVaultKey,
} from "../src/commands/lint/env-key-rules";
import { akmLint } from "../src/commands/lint/index";
import { parsePlacementRef } from "../src/core/asset/resolve-ref";
import type { AkmConfig } from "../src/core/config/config";

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

  test("includes the GIT_CONFIG_ prefix pattern", () => {
    const hit = DANGEROUS_VAULT_KEY_PATTERNS.some(({ pattern }) => pattern.test("GIT_CONFIG_GLOBAL"));
    expect(hit).toBe(true);
  });

  test("isDangerousVaultKey matches BASH_FUNC_-prefixed names", () => {
    expect(isDangerousVaultKey("BASH_FUNC_x%%")).toBe(true);
    expect(isDangerousVaultKey("BASH_FUNC_evil()")).toBe(true);
    expect(isDangerousVaultKey("BASH_FUNC_foo")).toBe(true);
  });

  test("isDangerousVaultKey matches GIT_CONFIG_-prefixed names", () => {
    expect(isDangerousVaultKey("GIT_CONFIG_GLOBAL")).toBe(true);
    expect(isDangerousVaultKey("GIT_CONFIG_COUNT")).toBe(true);
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
    expect(findings[0]!.issue).toBe("dangerous-env-key");
    expect(findings[0]!.file).toBe("vaults/.env");
    expect(findings[0]!.detail).toContain("LD_PRELOAD");
    expect(findings[0]!.detail).toContain("akm env run");
    expect(findings[0]!.fixed).toBe(false);
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

    expect(findings[0]!.detail).toContain("vault:staging");
  });

  test("flags LD_BIND_NOW (extended LD_* family)", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "ld.env", "LD_BIND_NOW=1\nSAFE=ok\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/ld.env", "vault:ld");

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("LD_BIND_NOW");
  });

  test("flags GIT_SSH_COMMAND (git RCE vector)", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "git.env", "GIT_SSH_COMMAND=/evil/ssh-wrapper.sh\nSAFE=ok\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/git.env", "vault:git");

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("GIT_SSH_COMMAND");
  });

  test("flags GIT_CONFIG_* variables (git config injection family)", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "git-config.env", "GIT_CONFIG_GLOBAL=/evil/gitconfig\nSAFE=ok\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/git-config.env", "vault:git-config");

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("GIT_CONFIG_GLOBAL");
  });

  test("flags NODE_TLS_REJECT_UNAUTHORIZED (MITM enabler)", () => {
    const stashDir = makeTempStash();
    const vaultPath = writeVault(stashDir, "tls.env", "NODE_TLS_REJECT_UNAUTHORIZED=0\nAPI_TOKEN=abc\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/tls.env", "vault:tls");

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  test("flags BASH_FUNC_ prefixed keys (Shellshock pattern check)", () => {
    const stashDir = makeTempStash();
    // .env parsing rejects "()" and "%%" in keys, so we test with a clean
    // BASH_FUNC_<name> form — the pattern still matches.
    const vaultPath = writeVault(stashDir, "shock.env", "BASH_FUNC_evil=value\nSAFE=ok\n");
    const findings = checkVaultForDangerousKeys(vaultPath, "vaults/shock.env", "vault:shock");

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("BASH_FUNC_evil");
  });
});

// ── akmLint integration ───────────────────────────────────────────────────────

describe("akmLint dangerous-vault-key integration", () => {
  test("flags a vault file containing LD_PRELOAD", async () => {
    const stashDir = makeTempStash();
    writeVault(stashDir, ".env", "LD_PRELOAD=/evil/lib.so\nSAFE_KEY=ok\n");

    const result = await akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-env-key");
    expect(dangerous).toHaveLength(1);
    expect(dangerous[0]!.detail).toContain("LD_PRELOAD");
    expect(dangerous[0]!.file).toContain(".env");
    // `result.ok` reflects "lint ran successfully", not "no findings".
    // Dangerous-vault-key findings now surface via summary.flagged; CLI
    // exit code is gated on --fail-on-flagged separately.
    expect(result.ok).toBe(true);
    expect(result.summary.flagged).toBeGreaterThan(0);
  });

  test("flags each dangerous key in a vault file separately", async () => {
    const stashDir = makeTempStash();
    writeVault(
      stashDir,
      "attack.env",
      ["DYLD_INSERT_LIBRARIES=/evil.dylib", "NODE_OPTIONS=--require evil", "SAFE_KEY=fine"].join("\n"),
    );

    const result = await akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-env-key");
    expect(dangerous).toHaveLength(2);
  });

  test("does not flag a vault file with only safe keys", async () => {
    const stashDir = makeTempStash();
    writeVault(stashDir, "clean.env", "API_TOKEN=abc\nDB_URL=postgres://localhost/db\n");

    const result = await akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-env-key");
    expect(dangerous).toHaveLength(0);
  });

  test("scans multiple vault files in the same stash", async () => {
    const stashDir = makeTempStash();
    writeVault(stashDir, "prod.env", "LD_PRELOAD=/evil.so\n");
    writeVault(stashDir, "dev.env", "SAFE=ok\n");
    writeVault(stashDir, "staging.env", "PATH=/evil:/usr/bin\n");

    const result = await akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-env-key");
    // One finding from prod.env (LD_PRELOAD) + one from staging.env (PATH)
    expect(dangerous).toHaveLength(2);
  });

  test("does not produce dangerous-vault-key findings when vaults/ dir is absent", async () => {
    const stashDir = makeTempStash();
    // No vaults/ dir at all

    const result = await akmLint({ dir: stashDir });

    const dangerous = result.flagged.filter((i) => i.issue === "dangerous-env-key");
    expect(dangerous).toHaveLength(0);
  });

  // The `Ref:` a finding prints must be a ref the CLI actually accepts. These
  // used to be hand-built in the retired `env:<name>` / `secret:<name>` colon
  // grammar, which `parseAssetRef` rejects — so copying the ref off a security
  // finding dead-ended at ASSET_NOT_FOUND.
  describe("emitted Ref: uses the canonical, resolvable grammar", () => {
    // Greedy up to the sentence-ending period, so a ref that itself contains a
    // dot (`secrets/creds.env`) is captured whole rather than truncated.
    const refOf = (detail: string): string | undefined => detail.match(/Ref: (\S+)\.\s/)?.[1];

    test("env asset refs are `env/<name>`, with `.env` mapping to env/default", async () => {
      const stashDir = makeTempStash();
      writeVault(stashDir, "prod.env", "LD_PRELOAD=/evil.so\n");
      writeVault(stashDir, ".env", "LD_PRELOAD=/evil.so\n");

      const refs = (await akmLint({ dir: stashDir })).flagged
        .filter((i) => i.issue === "dangerous-env-key")
        .map((i) => refOf(i.detail));

      expect(refs).toContain("env/prod");
      expect(refs).toContain("env/default");
      for (const ref of refs) expect(ref).not.toContain(":");
    });

    test("secret asset refs are `secrets/<filename>` (extension preserved)", async () => {
      const stashDir = makeTempStash();
      const secretsDir = path.join(stashDir, "secrets");
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(path.join(secretsDir, "creds.env"), "BASH_ENV=/tmp/x\n", { mode: 0o600 });

      const refs = (await akmLint({ dir: stashDir })).flagged
        .filter((i) => i.issue === "dangerous-env-key")
        .map((i) => refOf(i.detail));

      expect(refs).toContain("secrets/creds.env");
    });

    test("refs from non-default bundles include their bundle id", async () => {
      const primary = makeTempStash("akm-lint-primary-");
      const secondary = makeTempStash("akm-lint-secondary-");
      writeVault(primary, "prod.env", "LD_PRELOAD=/primary.so\n");
      writeVault(secondary, "prod.env", "LD_PRELOAD=/secondary.so\n");
      const config: AkmConfig = {
        semanticSearchMode: "off",
        defaultBundle: "primary",
        bundles: { primary: { path: primary }, team: { path: secondary } },
      };

      const refs = (await akmLint({ config })).flagged
        .filter((i) => i.issue === "dangerous-env-key")
        .map((i) => refOf(i.detail));

      expect(refs).toContain("env/prod");
      expect(refs).toContain("team//env/prod");
    });

    test("every emitted ref resolves to a real type through the ref grammar", async () => {
      const stashDir = makeTempStash();
      writeVault(stashDir, "prod.env", "LD_PRELOAD=/evil.so\n");
      const secretsDir = path.join(stashDir, "secrets");
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(path.join(secretsDir, "creds.env"), "BASH_ENV=/tmp/x\n", { mode: 0o600 });

      const findings = (await akmLint({ dir: stashDir })).flagged.filter((i) => i.issue === "dangerous-env-key");
      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        const ref = refOf(finding.detail);
        expect(ref).toBeDefined();
        // The retired colon grammar does not parse as a placement ref; a path ref does.
        const parts = parsePlacementRef(ref as string);
        expect(["env", "secret"]).toContain(parts.type);
      }
    });
  });
});
