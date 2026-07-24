import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { fingerprintEvalCases } from "./sources/eval-runs";
import { assertSafeRelativePath, assertSha256 } from "./twin-types";
import type {
  MaterializedInstallation,
  SafeRelativePath,
  Sha256,
  TwinMutationSummary,
  TwinResourceMetrics,
} from "./twin-types";
import type { EvalCase, EvalCaseResult, EvalRunResult } from "./types";

export interface FileManifestEntry {
  path: SafeRelativePath;
  byteSize: number;
  sha256: Sha256;
}

export interface FileManifest {
  schemaVersion: 1;
  fingerprint: Sha256;
  files: FileManifestEntry[];
}

export function ensurePrivateDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function writePrivateJson(file: string, value: unknown): void {
  writePrivateText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writePrivateText(file: string, value: string): void {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function assertNonOverlappingPaths(snapshotDir: string, outDir: string): void {
  const snapshot = resolvePhysicalPath(snapshotDir);
  const output = resolvePhysicalPath(outDir);
  if (
    snapshot === output ||
    snapshot.startsWith(`${output}${path.sep}`) ||
    output.startsWith(`${snapshot}${path.sep}`)
  ) {
    throw new Error("--snapshot and --out must not overlap");
  }
}

export function restrictTreeModes(root: string): void {
  const visit = (entryPath: string): void => {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) throw new Error(`private artifact tree contains a symbolic link: ${entryPath}`);
    if (stat.isDirectory()) {
      fs.chmodSync(entryPath, 0o700);
      for (const child of fs.readdirSync(entryPath)) visit(path.join(entryPath, child));
    } else if (stat.isFile()) {
      fs.chmodSync(entryPath, 0o600);
    } else {
      throw new Error(`private artifact tree contains an unsupported entry: ${entryPath}`);
    }
  };
  visit(root);
}

export function captureFileManifest(root: string): FileManifest {
  const files: FileManifestEntry[] = [];
  const visit = (directory: string): void => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      assertSafeRelativePath(relativePath);
      if (entry.isSymbolicLink()) throw new Error(`manifest does not permit symbolic links: ${relativePath}`);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolutePath);
        files.push({ path: relativePath, byteSize: bytes.byteLength, sha256: sha256(bytes) });
      } else {
        throw new Error(`manifest encountered unsupported entry: ${relativePath}`);
      }
    }
  };
  visit(root);
  return {
    schemaVersion: 1,
    fingerprint: sha256(
      Buffer.from(
        JSON.stringify(files.map(({ path: filePath, byteSize, sha256: digest }) => ({ path: filePath, byteSize, sha256: digest }))),
        "utf8",
      ),
    ),
    files,
  };
}

export function summarizeMutations(before?: FileManifest, after?: FileManifest): TwinMutationSummary {
  if (!before || !after) {
    return {
      initialManifestFingerprint: before?.fingerprint ?? null,
      finalManifestFingerprint: after?.fingerprint ?? null,
      addedFileCount: 0,
      modifiedFileCount: 0,
      removedFileCount: 0,
      modifiedDatabaseCount: 0,
    };
  }
  const beforeByPath = new Map(before.files.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.files.map((entry) => [entry.path, entry]));
  const added = after.files.filter((entry) => !beforeByPath.has(entry.path));
  const removed = before.files.filter((entry) => !afterByPath.has(entry.path));
  const modified = after.files.filter((entry) => {
    const previous = beforeByPath.get(entry.path);
    return previous !== undefined && previous.sha256 !== entry.sha256;
  });
  return {
    initialManifestFingerprint: before.fingerprint,
    finalManifestFingerprint: after.fingerprint,
    addedFileCount: added.length,
    modifiedFileCount: modified.length,
    removedFileCount: removed.length,
    modifiedDatabaseCount: modified.filter((entry) => /\.db(?:-(?:wal|shm))?$/.test(entry.path)).length,
  };
}

export function manifestsMatchExceptConfig(
  left: FileManifest | undefined,
  right: FileManifest | undefined,
  configPath: SafeRelativePath | undefined,
): boolean {
  if (!left || !right || !configPath) return false;
  const comparable = (manifest: FileManifest): string =>
    JSON.stringify(
      manifest.files
        .filter((entry) => entry.path !== configPath)
        .map(({ path: filePath, byteSize, sha256: digest }) => ({ path: filePath, byteSize, sha256: digest })),
    );
  return comparable(left) === comparable(right);
}

export function normalizedEffectiveConfigFingerprint(installation: MaterializedInstallation): Sha256 {
  const parsed = JSON.parse(fs.readFileSync(installation.configPath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("materialized config must be a JSON object");
  const replacements = [
    [installation.configPath, "{{CONFIG}}"],
    [installation.dataDir, "{{DATA}}"],
    ...Object.entries(installation.bundleRoots).map(([id, root]) => [root, `{{BUNDLE:${id}}}`]),
    [installation.root, "{{ROOT}}"],
  ].sort((left, right) => right[0]!.length - left[0]!.length) as Array<[string, string]>;
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") {
      return replacements.reduce((current, [needle, replacement]) => current.replaceAll(needle, replacement), value);
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, normalize(value[key])]),
    );
  };
  return sha256(Buffer.from(JSON.stringify(normalize(parsed)), "utf8"));
}

export function loadSuite(suite: string): { cases: EvalCase[]; fingerprint: Sha256 } {
  const casesRoot = path.resolve(path.join(import.meta.dir, "..", "cases"));
  const suiteDir = path.join(casesRoot, suite);
  if (!fs.existsSync(suiteDir)) throw new Error(`suite directory not found: ${suiteDir}`);
  const cases = fs
    .readdirSync(suiteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const file = path.join(suiteDir, entry.name);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as EvalCase;
      if (parsed.schemaVersion !== 1 || !parsed.id || !parsed.type) throw new Error(`invalid eval case: ${file}`);
      return parsed;
    });
  const fingerprint = fingerprintEvalCases(cases, suiteDir);
  assertSha256(fingerprint);
  return { cases, fingerprint };
}

export function loadLatestEvalArtifacts(outRoot: string): {
  evalResult: EvalRunResult;
  caseResults: EvalCaseResult[];
} {
  const runsRoot = path.join(outRoot, "runs");
  const runIds = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(runsRoot, entry.name, "eval-result.json")))
    .map((entry) => entry.name)
    .sort();
  const runId = runIds.at(-1);
  if (!runId) throw new Error(`no completed eval run under ${runsRoot}`);
  const runDir = path.join(runsRoot, runId);
  const evalResult = JSON.parse(fs.readFileSync(path.join(runDir, "eval-result.json"), "utf8")) as EvalRunResult;
  if (
    evalResult.schemaVersion !== 2 ||
    !evalResult.inputs?.suiteFingerprint ||
    !Number.isInteger(evalResult.inputs.caseCount) ||
    !Number.isFinite(evalResult.scores?.deterministic) ||
    !Array.isArray(evalResult.errors)
  ) {
    throw new Error("eval-result must be complete schemaVersion 2 data");
  }
  const caseResults: EvalCaseResult[] = [];
  const caseFile = path.join(runDir, "case-results.jsonl");
  for (const [lineIndex, line] of fs.readFileSync(caseFile, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as EvalCaseResult;
      if (
        !parsed.caseId ||
        !Number.isFinite(parsed.score) ||
        typeof parsed.passed !== "boolean" ||
        (parsed.errors !== undefined &&
          (!Array.isArray(parsed.errors) || parsed.errors.some((error) => typeof error !== "string")))
      ) {
        throw new Error("missing required fields");
      }
      caseResults.push(parsed);
    } catch (error) {
      throw new Error(`invalid case-results.jsonl line ${lineIndex + 1}: ${errorMessage(error)}`);
    }
  }
  return { evalResult, caseResults };
}

export function readMaxEventId(stateDbPath: string): number {
  if (!fs.existsSync(stateDbPath)) throw new Error("state.db is unavailable for resource telemetry");
  const db = new Database(stateDbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number };
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("resource telemetry cursor is invalid");
    return id;
  } finally {
    db.close();
  }
}

export function readImproveResourceMetrics(
  stateDbPath: string,
  afterEventId: number,
  throughEventId: number,
  wallDurationMs: number,
): TwinResourceMetrics {
  if (
    !Number.isSafeInteger(afterEventId) ||
    !Number.isSafeInteger(throughEventId) ||
    afterEventId < 0 ||
    throughEventId < afterEventId ||
    !Number.isFinite(wallDurationMs) ||
    wallDurationMs < 0
  ) {
    throw new Error("invalid improve telemetry bounds");
  }
  const db = new Database(stateDbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT event_type, metadata_json FROM events WHERE event_type IN ('llm_usage', 'llm_usage_summary') AND id > ? AND id <= ? ORDER BY id",
      )
      .all(afterEventId, throughEventId) as Array<{ event_type: string; metadata_json: string }>;
    const terminalRows = rows.filter((row) => row.event_type === "llm_usage");
    const summaryRows = rows.filter((row) => row.event_type === "llm_usage_summary");
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let modelCallDurationMs = 0;
    let telemetryComplete = summaryRows.length === 1;
    const observedModelIds = new Set<string>();
    for (const row of terminalRows) {
      let metadata: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(row.metadata_json) as unknown;
        if (isRecord(parsed)) metadata = parsed;
      } catch {
        // A malformed row still counts as a visible terminal attempt.
      }
      if (!metadata) {
        telemetryComplete = false;
        continue;
      }
      if (metadata.outcome !== "success") telemetryComplete = false;
      for (const field of ["promptTokens", "completionTokens", "totalTokens", "durationMs"] as const) {
        if (typeof metadata[field] !== "number" || !Number.isFinite(metadata[field]) || metadata[field] < 0) {
          telemetryComplete = false;
        }
      }
      if (metadata.modelSource !== "response") {
        telemetryComplete = false;
      } else if (typeof metadata.model === "string" && metadata.model.trim().length > 0) {
        observedModelIds.add(metadata.model);
      } else {
        telemetryComplete = false;
      }
      promptTokens += numberValue(metadata.promptTokens);
      completionTokens += numberValue(metadata.completionTokens);
      totalTokens += numberValue(metadata.totalTokens);
      modelCallDurationMs += numberValue(metadata.durationMs);
    }
    let expectedTerminalRecords: number | undefined;
    if (summaryRows.length === 1) {
      try {
        const metadata = JSON.parse(summaryRows[0]!.metadata_json) as unknown;
        if (
          isRecord(metadata) &&
          typeof metadata.expectedTerminalRecords === "number" &&
          Number.isSafeInteger(metadata.expectedTerminalRecords) &&
          metadata.expectedTerminalRecords >= 0
        ) {
          expectedTerminalRecords = metadata.expectedTerminalRecords as number;
        } else {
          telemetryComplete = false;
        }
      } catch {
        telemetryComplete = false;
      }
    }
    if (expectedTerminalRecords === undefined || expectedTerminalRecords !== terminalRows.length) telemetryComplete = false;
    return {
      modelCalls: terminalRows.length,
      promptTokens,
      completionTokens,
      totalTokens,
      wallDurationMs,
      modelCallDurationMs,
      tokensPerSecond:
        totalTokens > 0 && modelCallDurationMs > 0 ? totalTokens / (modelCallDurationMs / 1000) : null,
      telemetryComplete,
      observedModelIds: [...observedModelIds].sort(),
    };
  } finally {
    db.close();
  }
}

export function createAkmCommandWrapper(directory: string): string {
  const wrapper = path.join(directory, "akm-command-wrapper.ts");
  writePrivateText(
    wrapper,
    `#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
const encoded = process.env.AKM_EVAL_TWIN_AKM_COMMAND_B64;
if (!encoded) {
  process.stderr.write("missing AKM command vector\\n");
  process.exit(2);
}
const command = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) {
  process.stderr.write("invalid AKM command vector\\n");
  process.exit(2);
}
const timeoutMs = Number(process.env.AKM_EVAL_TWIN_COMMAND_TIMEOUT_MS);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  process.stderr.write("invalid AKM command timeout\\n");
  process.exit(2);
}
const env = { ...process.env };
delete env.AKM_EVAL_TWIN_AKM_COMMAND_B64;
delete env.AKM_EVAL_TWIN_COMMAND_TIMEOUT_MS;
const result = spawnSync(command[0], [...command.slice(1), ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  timeout: timeoutMs,
  killSignal: "SIGKILL",
});
if (result.error) {
  process.stderr.write("AKM command failed to spawn\\n");
  process.exit(2);
}
process.exit(result.status ?? 1);
`,
  );
  fs.chmodSync(wrapper, 0o700);
  return wrapper;
}

export function emptyResourceMetrics(): TwinResourceMetrics {
  return {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    wallDurationMs: 0,
    modelCallDurationMs: 0,
    tokensPerSecond: null,
    telemetryComplete: false,
    observedModelIds: [],
  };
}

export function sha256(bytes: Uint8Array): Sha256 {
  return crypto.createHash("sha256").update(bytes).digest("hex") as Sha256;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function resolvePhysicalPath(inputPath: string): string {
  let existing = path.resolve(inputPath);
  const missingParts: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingParts.unshift(path.basename(existing));
    existing = parent;
  }
  const physical = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
  return path.resolve(physical, ...missingParts);
}
