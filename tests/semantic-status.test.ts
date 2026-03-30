import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConfig } from "../src/config";
import {
  BLOCKED_TTL_MS,
  classifySemanticFailure,
  clearSemanticStatus,
  deriveSemanticProviderFingerprint,
  getEffectiveSemanticStatus,
  isSemanticRuntimeReady,
  readSemanticStatus,
  type SemanticSearchStatus,
  writeSemanticStatus,
} from "../src/semantic-status";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-sem-status-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Minimal config with semantic search "auto" and no custom embedding. */
function autoConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    ...overrides,
  };
}

/** Minimal config with semantic search disabled. */
function offConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return {
    semanticSearchMode: "off",
    ...overrides,
  };
}

function makeStatus(overrides: Partial<SemanticSearchStatus> = {}): SemanticSearchStatus {
  return {
    status: "ready-vec",
    providerFingerprint: deriveSemanticProviderFingerprint(undefined),
    lastCheckedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Environment isolation ────────────────────────────────────────────────────

let tmpDir = "";
const originalCacheDir = process.env.AKM_CACHE_DIR;

beforeEach(() => {
  tmpDir = makeTmpDir();
  process.env.AKM_CACHE_DIR = tmpDir;
});

afterEach(() => {
  if (originalCacheDir === undefined) {
    delete process.env.AKM_CACHE_DIR;
  } else {
    process.env.AKM_CACHE_DIR = originalCacheDir;
  }
  if (tmpDir) {
    cleanup(tmpDir);
    tmpDir = "";
  }
});

// ── readSemanticStatus / writeSemanticStatus / clearSemanticStatus ───────────

describe("readSemanticStatus", () => {
  test("returns undefined when file does not exist", () => {
    expect(readSemanticStatus()).toBeUndefined();
  });

  test("returns undefined when file contains corrupt JSON", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "semantic-status.json"), "{ not valid json", "utf8");
    expect(readSemanticStatus()).toBeUndefined();
  });

  test("returns undefined when file has wrong shape (missing required fields)", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "semantic-status.json"), JSON.stringify({ status: "ready-vec" }), "utf8");
    expect(readSemanticStatus()).toBeUndefined();
  });

  test("returns undefined when status field has an unknown value", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const bad = {
      status: "unknown-status",
      providerFingerprint: "local:default",
      lastCheckedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(tmpDir, "semantic-status.json"), JSON.stringify(bad), "utf8");
    expect(readSemanticStatus()).toBeUndefined();
  });

  test("round-trips a full status object with optional fields", () => {
    const original = makeStatus({
      status: "blocked",
      reason: "missing-package",
      message: "Cannot find module",
      entryCount: 42,
      embeddingCount: 38,
    });
    writeSemanticStatus(original);
    const read = readSemanticStatus();
    expect(read).toBeDefined();
    expect(read?.status).toBe("blocked");
    expect(read?.reason).toBe("missing-package");
    expect(read?.message).toBe("Cannot find module");
    expect(read?.entryCount).toBe(42);
    expect(read?.embeddingCount).toBe(38);
    expect(read?.providerFingerprint).toBe(original.providerFingerprint);
    expect(read?.lastCheckedAt).toBe(original.lastCheckedAt);
  });

  test("round-trips status without optional fields", () => {
    const original = makeStatus({ status: "pending" });
    writeSemanticStatus(original);
    const read = readSemanticStatus();
    expect(read).toBeDefined();
    expect(read?.status).toBe("pending");
    expect(read?.reason).toBeUndefined();
    expect(read?.message).toBeUndefined();
    expect(read?.entryCount).toBeUndefined();
    expect(read?.embeddingCount).toBeUndefined();
  });
});

describe("writeSemanticStatus", () => {
  test("creates the cache directory if it does not exist", () => {
    const nested = path.join(tmpDir, "nested", "cache");
    process.env.AKM_CACHE_DIR = nested;
    const status = makeStatus();
    writeSemanticStatus(status);
    expect(fs.existsSync(path.join(nested, "semantic-status.json"))).toBe(true);
    process.env.AKM_CACHE_DIR = tmpDir;
    cleanup(nested);
  });

  test("overwrites an existing status file atomically", () => {
    const first = makeStatus({ status: "pending" });
    writeSemanticStatus(first);
    const second = makeStatus({ status: "ready-js" });
    writeSemanticStatus(second);
    const read = readSemanticStatus();
    expect(read?.status).toBe("ready-js");
  });

  test("does not leave a .tmp file behind after successful write", () => {
    writeSemanticStatus(makeStatus());
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("clearSemanticStatus", () => {
  test("removes the status file when it exists", () => {
    writeSemanticStatus(makeStatus());
    const filePath = path.join(tmpDir, "semantic-status.json");
    expect(fs.existsSync(filePath)).toBe(true);
    clearSemanticStatus();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("does not throw when file does not exist", () => {
    expect(() => clearSemanticStatus()).not.toThrow();
  });

  test("after clear, readSemanticStatus returns undefined", () => {
    writeSemanticStatus(makeStatus());
    clearSemanticStatus();
    expect(readSemanticStatus()).toBeUndefined();
  });
});

// ── getEffectiveSemanticStatus ───────────────────────────────────────────────

describe("getEffectiveSemanticStatus", () => {
  test('mode "off" returns "disabled" regardless of status file', () => {
    writeSemanticStatus(makeStatus({ status: "ready-vec" }));
    expect(getEffectiveSemanticStatus(offConfig())).toBe("disabled");
  });

  test('mode "off" returns "disabled" even with no status file', () => {
    expect(getEffectiveSemanticStatus(offConfig())).toBe("disabled");
  });

  test('no status file + mode "auto" returns "pending"', () => {
    expect(getEffectiveSemanticStatus(autoConfig())).toBe("pending");
  });

  test('status "ready-vec" with matching fingerprint returns "ready-vec"', () => {
    const status = makeStatus({ status: "ready-vec" });
    expect(getEffectiveSemanticStatus(autoConfig(), status)).toBe("ready-vec");
  });

  test('status "ready-js" with matching fingerprint returns "ready-js"', () => {
    const status = makeStatus({ status: "ready-js" });
    expect(getEffectiveSemanticStatus(autoConfig(), status)).toBe("ready-js");
  });

  test('status "pending" with matching fingerprint returns "pending"', () => {
    const status = makeStatus({ status: "pending" });
    expect(getEffectiveSemanticStatus(autoConfig(), status)).toBe("pending");
  });

  test('status "blocked" with matching fingerprint and recent timestamp returns "blocked"', () => {
    const status = makeStatus({ status: "blocked", lastCheckedAt: new Date().toISOString() });
    expect(getEffectiveSemanticStatus(autoConfig(), status)).toBe("blocked");
  });

  test("status with DIFFERENT fingerprint returns pending (config changed)", () => {
    // Status was written with a remote config fingerprint.
    const status = makeStatus({
      status: "ready-vec",
      providerFingerprint: "remote:http://old-server/v1|old-model|384",
    });
    // Current config has no embedding (local default) — fingerprint won't match.
    expect(getEffectiveSemanticStatus(autoConfig(), status)).toBe("pending");
  });

  test("fingerprint mismatch: switching from local to remote returns pending", () => {
    const localFingerprint = deriveSemanticProviderFingerprint(undefined);
    const status = makeStatus({ status: "ready-vec", providerFingerprint: localFingerprint });
    const configWithRemote = autoConfig({
      embedding: {
        endpoint: "http://localhost:11434/v1/embeddings",
        model: "nomic-embed-text",
      },
    });
    expect(getEffectiveSemanticStatus(configWithRemote, status)).toBe("pending");
  });

  test('blocked status older than BLOCKED_TTL_MS returns "pending" (auto-recovery)', () => {
    const oldTimestamp = new Date(Date.now() - BLOCKED_TTL_MS - 1000).toISOString();
    const status = makeStatus({ status: "blocked", lastCheckedAt: oldTimestamp });
    expect(getEffectiveSemanticStatus(autoConfig(), status)).toBe("pending");
  });

  test("blocked status newer than BLOCKED_TTL_MS stays blocked", () => {
    const recentTimestamp = new Date(Date.now() - 1000).toISOString();
    const status = makeStatus({ status: "blocked", lastCheckedAt: recentTimestamp });
    expect(getEffectiveSemanticStatus(autoConfig(), status)).toBe("blocked");
  });

  test("blocked status with invalid lastCheckedAt returns pending (safe fallback)", () => {
    const status = makeStatus({ status: "blocked", lastCheckedAt: "not-a-date" });
    expect(getEffectiveSemanticStatus(autoConfig(), status)).toBe("pending");
  });

  // ── File-round-trip auto-recovery tests (exercise readSemanticStatus path) ──

  test("returns 'pending' for blocked status older than BLOCKED_TTL_MS (file round-trip)", () => {
    const AUTO_CONFIG = autoConfig();
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeSemanticStatus({
      status: "blocked",
      reason: "missing-package",
      providerFingerprint: deriveSemanticProviderFingerprint(AUTO_CONFIG.embedding),
      lastCheckedAt: oldDate,
    });
    const result = getEffectiveSemanticStatus(AUTO_CONFIG);
    expect(result).toBe("pending"); // auto-recovered
  });

  test("returns 'blocked' for blocked status newer than BLOCKED_TTL_MS (file round-trip)", () => {
    const AUTO_CONFIG = autoConfig();
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    writeSemanticStatus({
      status: "blocked",
      reason: "missing-package",
      providerFingerprint: deriveSemanticProviderFingerprint(AUTO_CONFIG.embedding),
      lastCheckedAt: recentDate,
    });
    const result = getEffectiveSemanticStatus(AUTO_CONFIG);
    expect(result).toBe("blocked"); // not yet recovered
  });

  test("returns 'pending' for blocked status with invalid lastCheckedAt (file round-trip)", () => {
    const AUTO_CONFIG = autoConfig();
    writeSemanticStatus({
      status: "blocked",
      reason: "unknown",
      providerFingerprint: deriveSemanticProviderFingerprint(AUTO_CONFIG.embedding),
      lastCheckedAt: "not-a-date",
    });
    const result = getEffectiveSemanticStatus(AUTO_CONFIG);
    expect(result).toBe("pending"); // NaN check triggers recovery
  });
});

// ── isSemanticRuntimeReady ────────────────────────────────────────────────────

describe("isSemanticRuntimeReady", () => {
  test('"ready-vec" returns true', () => {
    expect(isSemanticRuntimeReady("ready-vec")).toBe(true);
  });

  test('"ready-js" returns true', () => {
    expect(isSemanticRuntimeReady("ready-js")).toBe(true);
  });

  test('"pending" returns false', () => {
    expect(isSemanticRuntimeReady("pending")).toBe(false);
  });

  test('"blocked" returns false', () => {
    expect(isSemanticRuntimeReady("blocked")).toBe(false);
  });

  test('"disabled" returns false', () => {
    expect(isSemanticRuntimeReady("disabled")).toBe(false);
  });
});

// ── classifySemanticFailure ──────────────────────────────────────────────────

describe("classifySemanticFailure", () => {
  // Auth errors
  test("401 status → remote-auth", () => {
    expect(classifySemanticFailure("Request failed with status 401")).toBe("remote-auth");
  });

  test("403 status → remote-auth", () => {
    expect(classifySemanticFailure("HTTP 403 Forbidden")).toBe("remote-auth");
  });

  test("auth keyword → remote-auth", () => {
    expect(classifySemanticFailure("Authentication failed")).toBe("remote-auth");
  });

  test("unauthorized keyword → remote-auth", () => {
    expect(classifySemanticFailure("Error: Unauthorized access denied")).toBe("remote-auth");
  });

  // Rate limit errors
  test("429 status → remote-rate-limit", () => {
    expect(classifySemanticFailure("HTTP 429 Too Many Requests")).toBe("remote-rate-limit");
  });

  test("rate limit keyword → remote-rate-limit", () => {
    expect(classifySemanticFailure("You have exceeded the rate limit")).toBe("remote-rate-limit");
  });

  test("quota keyword → remote-rate-limit", () => {
    expect(classifySemanticFailure("API quota exceeded for this month")).toBe("remote-rate-limit");
  });

  // Missing package (takes priority over model/download)
  test("transformers keyword → missing-package", () => {
    expect(classifySemanticFailure("Cannot find module '@huggingface/transformers'")).toBe("missing-package");
  });

  test("missing-package keyword → missing-package", () => {
    expect(classifySemanticFailure("Error: missing-package detected")).toBe("missing-package");
  });

  // Model download
  test("download keyword without model keyword → local-model-download", () => {
    expect(classifySemanticFailure("Failed to download file from HuggingFace")).toBe("local-model-download");
  });

  test("download + generic model word → local-model-download (model alone no longer matches)", () => {
    expect(classifySemanticFailure("Failed to download model weights")).toBe("local-model-download");
  });

  // Remote model errors (404, "model not found", bad request)
  test("404 status → remote-model", () => {
    expect(classifySemanticFailure("HTTP 404 Not Found")).toBe("remote-model");
  });

  test("model not found → remote-model", () => {
    expect(classifySemanticFailure("Error: model not found on server")).toBe("remote-model");
  });

  test("bad request keyword → remote-model", () => {
    expect(classifySemanticFailure("400 Bad Request: invalid parameters")).toBe("remote-model");
  });

  // Dimension mismatch
  test("dimension mismatch → dimension-mismatch", () => {
    expect(classifySemanticFailure("Error: dimension mismatch, expected 384 got 768")).toBe("dimension-mismatch");
  });

  // Database errors
  test("sqlite keyword → db-open", () => {
    expect(classifySemanticFailure("SQLite error: unable to open database")).toBe("db-open");
  });

  test("db keyword → db-open", () => {
    expect(classifySemanticFailure("Failed to open db connection")).toBe("db-open");
  });

  test("cache dir keyword → db-open", () => {
    expect(classifySemanticFailure("cache dir is read-only")).toBe("db-open");
  });

  // Network errors
  test("timeout keyword → remote-network", () => {
    expect(classifySemanticFailure("Request timeout after 30s")).toBe("remote-network");
  });

  test("unreachable keyword → remote-network", () => {
    expect(classifySemanticFailure("Host unreachable: connection refused")).toBe("remote-network");
  });

  test("refused keyword → remote-network", () => {
    expect(classifySemanticFailure("ECONNREFUSED 127.0.0.1:11434")).toBe("remote-network");
  });

  test("network keyword → remote-network", () => {
    expect(classifySemanticFailure("Network error occurred")).toBe("remote-network");
  });

  test("fetch keyword → remote-network", () => {
    expect(classifySemanticFailure("fetch failed: getaddrinfo ENOTFOUND")).toBe("remote-network");
  });

  // Permission denied
  test("EACCES → permission-denied", () => {
    expect(classifySemanticFailure("EACCES: permission denied, open '/root/.cache/akm'")).toBe("permission-denied");
  });

  test("permission denied keyword → permission-denied", () => {
    expect(classifySemanticFailure("Error: permission denied writing to cache")).toBe("permission-denied");
  });

  // ONNX-specific
  test("ONNX keyword → onnx-runtime-failed", () => {
    expect(classifySemanticFailure("Could not load ONNX runtime")).toBe("onnx-runtime-failed");
  });

  test("onnxruntime keyword → onnx-runtime-failed", () => {
    expect(classifySemanticFailure("onnxruntime-node failed to initialize")).toBe("onnx-runtime-failed");
  });

  // Native library / shared library
  test("shared library → native-lib-missing", () => {
    expect(classifySemanticFailure("Error loading shared library libstdc++.so.6")).toBe("native-lib-missing");
  });

  test("GLIBC keyword → native-lib-missing", () => {
    expect(classifySemanticFailure("version GLIBC_2.28 not found")).toBe("native-lib-missing");
  });

  test("musl keyword → native-lib-missing", () => {
    expect(classifySemanticFailure("musl libc not compatible")).toBe("native-lib-missing");
  });

  // Unknown / catch-all
  test("unrecognized error → unknown", () => {
    expect(classifySemanticFailure("Something completely unexpected happened")).toBe("unknown");
  });

  test("empty string → unknown", () => {
    expect(classifySemanticFailure("")).toBe("unknown");
  });

  // Case insensitivity
  test("upper-case TIMEOUT → remote-network", () => {
    expect(classifySemanticFailure("TIMEOUT: server did not respond")).toBe("remote-network");
  });

  test("mixed-case Auth → remote-auth", () => {
    expect(classifySemanticFailure("Auth token expired")).toBe("remote-auth");
  });

  // ── Alpine / musl real-world error messages ────────────────────────────────

  test("Alpine musl linker error → native-lib-missing", () => {
    expect(
      classifySemanticFailure(
        "Error: Dynamic Linking Error: /opt/akm/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node: Error loading shared library ld-linux-x86-64.so.2: No such file or directory",
      ),
    ).toBe("native-lib-missing");
  });

  test("GLIBC version not found → native-lib-missing", () => {
    expect(
      classifySemanticFailure(
        "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.28' not found (required by /opt/akm/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node)",
      ),
    ).toBe("native-lib-missing");
  });
});

// ── deriveSemanticProviderFingerprint ────────────────────────────────────────

describe("deriveSemanticProviderFingerprint", () => {
  test("returns local fingerprint with default model when no config", () => {
    const fp = deriveSemanticProviderFingerprint(undefined);
    expect(fp).toBe("local:Xenova/bge-small-en-v1.5");
  });

  test("returns local fingerprint with default model when config has no endpoint", () => {
    const fp = deriveSemanticProviderFingerprint({ endpoint: "", model: "" });
    expect(fp).toBe("local:Xenova/bge-small-en-v1.5");
  });

  test("returns local fingerprint with custom localModel", () => {
    const fp = deriveSemanticProviderFingerprint({
      endpoint: "",
      model: "",
      localModel: "Xenova/all-MiniLM-L6-v2",
    });
    expect(fp).toBe("local:Xenova/all-MiniLM-L6-v2");
  });

  test("returns remote fingerprint with endpoint + model", () => {
    const fp = deriveSemanticProviderFingerprint({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    });
    expect(fp).toBe("remote:http://localhost:11434/v1/embeddings|nomic-embed-text|default");
  });

  test("returns remote fingerprint with endpoint + model + dimension", () => {
    const fp = deriveSemanticProviderFingerprint({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
      dimension: 768,
    });
    expect(fp).toBe("remote:http://localhost:11434/v1/embeddings|nomic-embed-text|768");
  });

  test("different endpoints produce different fingerprints", () => {
    const fp1 = deriveSemanticProviderFingerprint({
      endpoint: "http://server-a/v1/embeddings",
      model: "text-embedding-3-small",
    });
    const fp2 = deriveSemanticProviderFingerprint({
      endpoint: "http://server-b/v1/embeddings",
      model: "text-embedding-3-small",
    });
    expect(fp1).not.toBe(fp2);
  });

  test("different models produce different fingerprints", () => {
    const fp1 = deriveSemanticProviderFingerprint({
      endpoint: "http://localhost/v1/embeddings",
      model: "model-a",
    });
    const fp2 = deriveSemanticProviderFingerprint({
      endpoint: "http://localhost/v1/embeddings",
      model: "model-b",
    });
    expect(fp1).not.toBe(fp2);
  });

  test("different dimensions produce different fingerprints", () => {
    const base = { endpoint: "http://localhost/v1/embeddings", model: "my-model" };
    const fp1 = deriveSemanticProviderFingerprint({ ...base, dimension: 256 });
    const fp2 = deriveSemanticProviderFingerprint({ ...base, dimension: 512 });
    expect(fp1).not.toBe(fp2);
  });

  test("switching from local to remote produces a different fingerprint", () => {
    const localFp = deriveSemanticProviderFingerprint(undefined);
    const remoteFp = deriveSemanticProviderFingerprint({
      endpoint: "http://localhost:11434/v1/embeddings",
      model: "nomic-embed-text",
    });
    expect(localFp).not.toBe(remoteFp);
  });

  test("fingerprint is deterministic (same inputs → same output)", () => {
    const config = {
      endpoint: "http://example.com/v1/embeddings",
      model: "embed-model",
      dimension: 384,
    };
    expect(deriveSemanticProviderFingerprint(config)).toBe(deriveSemanticProviderFingerprint(config));
  });
});
