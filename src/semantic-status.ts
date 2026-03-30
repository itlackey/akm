import fs from "node:fs";
import path from "node:path";
import type { AkmConfig, EmbeddingConnectionConfig } from "./config";
import { getCacheDir, getSemanticStatusPath } from "./paths";

export type SemanticSearchRuntimeStatus = "pending" | "ready-js" | "ready-vec" | "blocked";
export type SemanticSearchEffectiveStatus = "disabled" | SemanticSearchRuntimeStatus;
export type SemanticSearchReason =
  | "missing-package"
  | "local-model-download"
  | "remote-network"
  | "remote-auth"
  | "remote-model"
  | "remote-rate-limit"
  | "db-open"
  | "db-locked"
  | "index-missing"
  | "dimension-mismatch"
  | "onnx-runtime-failed"
  | "native-lib-missing"
  | "permission-denied"
  | "index-failed"
  | "unknown";

export interface SemanticSearchStatus {
  status: SemanticSearchRuntimeStatus;
  reason?: SemanticSearchReason;
  message?: string;
  providerFingerprint: string;
  lastCheckedAt: string;
  entryCount?: number;
  embeddingCount?: number;
}

export function deriveSemanticProviderFingerprint(embedding?: EmbeddingConnectionConfig): string {
  if (embedding?.endpoint) {
    return `remote:${embedding.endpoint}|${embedding.model}|${embedding.dimension ?? "default"}`;
  }
  return `local:${embedding?.localModel ?? "Xenova/bge-small-en-v1.5"}`;
}

export function readSemanticStatus(): SemanticSearchStatus | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(getSemanticStatusPath(), "utf8")) as Record<string, unknown>;
    if (
      (raw.status === "pending" ||
        raw.status === "ready-js" ||
        raw.status === "ready-vec" ||
        raw.status === "blocked") &&
      typeof raw.providerFingerprint === "string" &&
      typeof raw.lastCheckedAt === "string"
    ) {
      const status: SemanticSearchStatus = {
        status: raw.status,
        providerFingerprint: raw.providerFingerprint,
        lastCheckedAt: raw.lastCheckedAt,
      };
      if (typeof raw.reason === "string") status.reason = raw.reason as SemanticSearchReason;
      if (typeof raw.message === "string") status.message = raw.message;
      if (typeof raw.entryCount === "number") status.entryCount = raw.entryCount;
      if (typeof raw.embeddingCount === "number") status.embeddingCount = raw.embeddingCount;
      return status;
    }
  } catch {
    // ignore corrupt or missing semantic status
  }
  return undefined;
}

export function writeSemanticStatus(status: SemanticSearchStatus): void {
  const dir = getCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getSemanticStatusPath();
  const tmpPath = path.join(dir, `semantic-status.json.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

export function clearSemanticStatus(): void {
  try {
    fs.unlinkSync(getSemanticStatusPath());
  } catch {
    // ignore missing file
  }
}

/** How long a "blocked" status is retained before the system retries. 24 hours. */
export const BLOCKED_TTL_MS = 24 * 60 * 60 * 1000;

export function getEffectiveSemanticStatus(
  config: AkmConfig,
  status = readSemanticStatus(),
): SemanticSearchEffectiveStatus {
  if (config.semanticSearchMode === "off") return "disabled";
  if (!status) return "pending";
  const fingerprint = deriveSemanticProviderFingerprint(config.embedding);
  if (status.providerFingerprint !== fingerprint) return "pending";
  // Auto-recovery: if blocked status is older than BLOCKED_TTL_MS, treat as pending
  // so the next index run will re-attempt semantic setup.
  if (status.status === "blocked") {
    const checkedAt = new Date(status.lastCheckedAt).getTime();
    if (Number.isNaN(checkedAt) || Date.now() - checkedAt > BLOCKED_TTL_MS) {
      return "pending";
    }
  }
  return status.status;
}

export function isSemanticRuntimeReady(status: SemanticSearchEffectiveStatus): boolean {
  return status === "ready-js" || status === "ready-vec";
}

export function classifySemanticFailure(message: string): SemanticSearchReason {
  const lower = message.toLowerCase();
  if (lower.includes("401") || lower.includes("403") || lower.includes("auth") || lower.includes("unauthorized")) {
    return "remote-auth";
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("quota")) {
    return "remote-rate-limit";
  }
  if (lower.includes("eacces") || lower.includes("permission denied")) {
    return "permission-denied";
  }
  // Native library / linker errors must be checked before the generic ONNX
  // match because Alpine/musl linker errors often contain "onnxruntime" in
  // the library path (e.g. onnxruntime_binding.node).
  if (
    lower.includes("shared library") ||
    lower.includes("glibc") ||
    lower.includes("musl") ||
    lower.includes("libc.so")
  ) {
    return "native-lib-missing";
  }
  if (lower.includes("onnx") || lower.includes("onnxruntime")) {
    return "onnx-runtime-failed";
  }
  if (lower.includes("404") || lower.includes("model not found") || lower.includes("bad request")) {
    return "remote-model";
  }
  if (lower.includes("transformers") || lower.includes("missing-package")) {
    return "missing-package";
  }
  if (lower.includes("download")) {
    return "local-model-download";
  }
  if (lower.includes("dimension mismatch")) {
    return "dimension-mismatch";
  }
  if (lower.includes("db") || lower.includes("sqlite") || lower.includes("cache dir")) {
    return "db-open";
  }
  if (
    lower.includes("timeout") ||
    lower.includes("unreachable") ||
    lower.includes("refused") ||
    lower.includes("network") ||
    lower.includes("fetch")
  ) {
    return "remote-network";
  }
  return "unknown";
}
