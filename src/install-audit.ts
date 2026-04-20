import fs from "node:fs";
import path from "node:path";
import { filterNonEmptyStrings } from "./common";
import type { AkmConfig } from "./config";
import type { KitSource } from "./registry-types";

export type InstallAuditSeverity = "low" | "moderate" | "high" | "critical";
export type InstallAuditCategory = "prompt-injection" | "install-script" | "malicious-code";

export interface InstallAuditFinding {
  id: string;
  severity: InstallAuditSeverity;
  category: InstallAuditCategory;
  message: string;
  file?: string;
  snippet?: string;
}

export interface InstallAuditSummary {
  low: number;
  moderate: number;
  high: number;
  critical: number;
  total: number;
}

export interface InstallAuditReport {
  enabled: boolean;
  passed: boolean;
  blocked: boolean;
  registryLabels: string[];
  findings: InstallAuditFinding[];
  scannedFiles: number;
  scannedBytes: number;
  summary: InstallAuditSummary;
}

export interface ResolvedInstallAuditConfig {
  enabled: boolean;
  blockOnCritical: boolean;
  blockUnlistedRegistries: boolean;
  registryAllowlist: string[];
}

interface InstallAuditRule {
  id: string;
  severity: InstallAuditSeverity;
  category: InstallAuditCategory;
  message: string;
  pattern: RegExp;
}

const DEFAULT_INSTALL_AUDIT_CONFIG: ResolvedInstallAuditConfig = {
  enabled: true,
  blockOnCritical: true,
  blockUnlistedRegistries: false,
  registryAllowlist: [],
};

const MAX_SCANNED_FILE_BYTES = 256 * 1024;
const LIFECYCLE_SCRIPT_NAMES = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "prepare",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".md",
  ".ps1",
  ".py",
  ".rb",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const CONTENT_RULES: InstallAuditRule[] = [
  {
    id: "prompt-ignore-previous-instructions",
    severity: "high",
    category: "prompt-injection",
    message: "Contains instructions to ignore prior prompts or instructions.",
    pattern:
      /\b(ignore|disregard|forget)\b[^.\n]{0,100}\b(previous|prior|earlier)\b[^.\n]{0,100}\b(instructions?|prompts?|messages?)\b/i,
  },
  {
    id: "prompt-reveal-hidden-secrets",
    severity: "critical",
    category: "prompt-injection",
    message: "Contains instructions to reveal hidden prompts or secrets.",
    pattern:
      /\b(reveal|print|dump|show|exfiltrat(?:e|ion))\b[^.\n]{0,120}\b(system prompt|hidden instructions?|developer message|api key|token|secret|password)\b/i,
  },
  {
    id: "prompt-bypass-guardrails",
    severity: "high",
    category: "prompt-injection",
    message: "Contains instructions to bypass safety or security controls.",
    pattern: /\b(bypass|disable|ignore)\b[^.\n]{0,100}\b(safety|security|guardrails|restrictions|policies)\b/i,
  },
  {
    id: "remote-shell-pipe",
    severity: "critical",
    category: "malicious-code",
    message: "Downloads remote content and pipes it directly into a shell.",
    pattern: /\b(curl|wget)\b[^\n|]{0,200}\|\s*(sh|bash|zsh)\b/i,
  },
  {
    id: "powershell-download-exec",
    severity: "critical",
    category: "malicious-code",
    message: "Downloads remote content and executes it in PowerShell.",
    pattern: /\b(Invoke-WebRequest|iwr|curl)\b[^\n|]{0,200}\|\s*(iex|Invoke-Expression)\b/i,
  },
  {
    id: "powershell-encoded-command",
    severity: "critical",
    category: "malicious-code",
    message: "Uses an encoded PowerShell command.",
    pattern: /\bpowershell(?:\.exe)?\b[^\n]{0,120}\s-(?:enc|encodedcommand)\b/i,
  },
  {
    id: "credential-exfiltration-language",
    severity: "high",
    category: "malicious-code",
    message: "Contains language associated with credential or secret exfiltration.",
    pattern:
      /\b(exfiltrat(?:e|ion)|harvest|steal)\b[^.\n]{0,120}\b(credentials?|tokens?|secrets?|ssh keys?|passwords?|cookies?)\b/i,
  },
];

export function resolveInstallAuditConfig(config: AkmConfig | undefined): ResolvedInstallAuditConfig {
  const installAudit = config?.security?.installAudit;
  const allowlist =
    filterNonEmptyStrings(installAudit?.registryAllowlist) ??
    filterNonEmptyStrings(installAudit?.registryWhitelist) ??
    [];
  return {
    enabled: installAudit?.enabled ?? DEFAULT_INSTALL_AUDIT_CONFIG.enabled,
    blockOnCritical: installAudit?.blockOnCritical ?? DEFAULT_INSTALL_AUDIT_CONFIG.blockOnCritical,
    blockUnlistedRegistries:
      installAudit?.blockUnlistedRegistries ?? DEFAULT_INSTALL_AUDIT_CONFIG.blockUnlistedRegistries,
    registryAllowlist: allowlist.map((entry) => entry.trim().toLowerCase()),
  };
}

export function enforceRegistryInstallPolicy(
  registryLabels: string[],
  config: AkmConfig | undefined,
  ref: string,
): void {
  const resolved = resolveInstallAuditConfig(config);
  if (!resolved.blockUnlistedRegistries) return;
  if (resolved.registryAllowlist.length === 0) {
    throw new Error(
      `Install blocked for ${ref}: no registries are allowlisted. Configure security.installAudit.registryAllowlist or disable security.installAudit.blockUnlistedRegistries.`,
    );
  }
  const matched = registryLabels.some((label) => resolved.registryAllowlist.includes(label.toLowerCase()));
  if (matched) return;
  throw new Error(
    `Install blocked for ${ref}: registry is not allowlisted. Allowed: ${resolved.registryAllowlist.join(", ")}. Seen: ${registryLabels.join(", ")}.`,
  );
}

export function auditInstallCandidate(input: {
  rootDir: string;
  source: KitSource;
  ref: string;
  registryLabels: string[];
  config: AkmConfig | undefined;
}): InstallAuditReport {
  const resolved = resolveInstallAuditConfig(input.config);
  if (!resolved.enabled) {
    return {
      enabled: false,
      passed: true,
      blocked: false,
      registryLabels: [...input.registryLabels],
      findings: [],
      scannedFiles: 0,
      scannedBytes: 0,
      summary: buildSummary([]),
    };
  }

  const findings: InstallAuditFinding[] = [];
  const counters = { scannedFiles: 0, scannedBytes: 0 };
  scanDirectory(input.rootDir, input.rootDir, findings, counters);
  const summary = buildSummary(findings);
  const blocked = resolved.blockOnCritical && summary.critical > 0;

  return {
    enabled: true,
    passed: findings.length === 0,
    blocked,
    registryLabels: [...input.registryLabels],
    findings,
    scannedFiles: counters.scannedFiles,
    scannedBytes: counters.scannedBytes,
    summary,
  };
}

export function formatInstallAuditFailure(ref: string, report: InstallAuditReport): string {
  const lines = [`Security audit failed for ${ref}.`, formatInstallAuditSummary(report)];
  for (const finding of report.findings.slice(0, 5)) {
    lines.push(`- [${finding.severity}] ${finding.message}${finding.file ? ` (${finding.file})` : ""}`);
  }
  if (report.findings.length > 5) {
    lines.push(`- ${report.findings.length - 5} more finding(s) omitted`);
  }
  lines.push(
    "Disable blocking with `security.installAudit.blockOnCritical = false`, or disable audits with `security.installAudit.enabled = false`.",
  );
  return lines.join("\n");
}

export function formatInstallAuditSummary(report: InstallAuditReport): string {
  if (!report.enabled) return "Audit: disabled";
  const severitySummary = [];
  if (report.summary.critical > 0) severitySummary.push(`${report.summary.critical} critical`);
  if (report.summary.high > 0) severitySummary.push(`${report.summary.high} high`);
  if (report.summary.moderate > 0) severitySummary.push(`${report.summary.moderate} moderate`);
  if (report.summary.low > 0) severitySummary.push(`${report.summary.low} low`);
  const detail = severitySummary.length > 0 ? severitySummary.join(", ") : "no findings";
  return `Audit: ${report.blocked ? "blocked" : report.passed ? "passed" : "warnings"} (${detail}; scanned ${report.scannedFiles} file${report.scannedFiles === 1 ? "" : "s"})`;
}

export function deriveRegistryLabels(input: {
  source: KitSource;
  ref: string;
  artifactUrl?: string;
  gitUrl?: string;
}): string[] {
  const labels = new Set<string>();
  labels.add(input.source);
  if (input.source === "github") labels.add("github.com");
  if (input.source === "npm") labels.add("npm");
  addUrlLabels(labels, input.artifactUrl);
  addUrlLabels(labels, input.gitUrl);
  if (input.source === "github" && input.ref.startsWith("github:")) {
    labels.add("github");
  }
  return [...labels];
}

function scanDirectory(
  dir: string,
  rootDir: string,
  findings: InstallAuditFinding[],
  counters: { scannedFiles: number; scannedBytes: number },
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath, rootDir, findings, counters);
      continue;
    }
    if (!entry.isFile()) continue;
    scanFile(fullPath, rootDir, findings, counters);
  }
}

function scanFile(
  filePath: string,
  rootDir: string,
  findings: InstallAuditFinding[],
  counters: { scannedFiles: number; scannedBytes: number },
): void {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (basename !== "package.json" && !TEXT_FILE_EXTENSIONS.has(ext)) return;

  let fileSize: number;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch {
    return;
  }

  const readSize = Math.min(fileSize, MAX_SCANNED_FILE_BYTES);
  const buf = Buffer.alloc(readSize);
  let bytesRead: number;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      bytesRead = fs.readSync(fd, buf, 0, readSize, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  if (bytesRead === 0) return;

  const bytes = buf.subarray(0, bytesRead);
  if (bytes.includes(0)) return;

  counters.scannedFiles += 1;
  counters.scannedBytes += bytesRead;

  const content = bytes.toString("utf8");
  const relativePath = path.relative(rootDir, filePath) || path.basename(filePath);
  const genericContent = basename === "package.json" ? stripPackageJsonScripts(content) : content;

  for (const rule of CONTENT_RULES) {
    const match = genericContent.match(rule.pattern);
    if (!match) continue;
    findings.push({
      id: rule.id,
      severity: rule.severity,
      category: rule.category,
      message: rule.message,
      file: relativePath,
      snippet: clipSnippet(match[0]),
    });
  }

  if (basename === "package.json") {
    scanPackageJson(content, relativePath, findings);
  }
}

function stripPackageJsonScripts(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return content;

  const packageJson = { ...(parsed as Record<string, unknown>) };
  delete packageJson.scripts;
  return JSON.stringify(packageJson, null, 2);
}

function scanPackageJson(content: string, relativePath: string, findings: InstallAuditFinding[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;

  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return;

  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (!LIFECYCLE_SCRIPT_NAMES.has(name) || typeof command !== "string") continue;
    for (const rule of CONTENT_RULES) {
      if (!rule.pattern.test(command)) continue;
      findings.push({
        id: `lifecycle-${name}-${rule.id}`,
        severity: rule.severity,
        category: "install-script",
        message: `Lifecycle script "${name}" is suspicious: ${rule.message.toLowerCase()}`,
        file: relativePath,
        snippet: clipSnippet(command),
      });
    }
  }
}

function clipSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}...`;
}

function buildSummary(findings: InstallAuditFinding[]): InstallAuditSummary {
  const summary: InstallAuditSummary = { low: 0, moderate: 0, high: 0, critical: 0, total: findings.length };
  for (const finding of findings) {
    summary[finding.severity] += 1;
  }
  return summary;
}

function addUrlLabels(labels: Set<string>, rawUrl: string | undefined): void {
  if (!rawUrl) return;
  try {
    const parsed = new URL(rawUrl);
    labels.add(parsed.hostname.toLowerCase());
  } catch {
    // Ignore non-URL refs (for example git@host:path)
  }
}
