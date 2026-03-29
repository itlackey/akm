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
  fs.renameSync(tmpPath, filePath);
}

export function clearSemanticStatus(): void {
  try {
    fs.unlinkSync(getSemanticStatusPath());
  } catch {
    // ignore missing file
  }
}

export function getEffectiveSemanticStatus(
  config: AkmConfig,
  status = readSemanticStatus(),
): SemanticSearchEffectiveStatus {
  if (config.semanticSearchMode === "off") return "disabled";
  if (!status) return "pending";
  const fingerprint = deriveSemanticProviderFingerprint(config.embedding);
  if (status.providerFingerprint !== fingerprint) return "pending";
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
  if (lower.includes("404") || lower.includes("model") || lower.includes("bad request")) {
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
  if (lower.includes("db") || lower.includes("sqlite") || lower.includes("cache")) {
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
