/**
 * Resolver + loader for completed eval-run directories under
 * `<stash>/.akm/evals/runs/`.
 *
 * Centralises "latest" handling and case-results.jsonl parsing so the
 * regression runner, compare command, and trend command don't each
 * reinvent it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvalCase, EvalCaseResult, EvalRunResult } from "../types";

export interface RunLocation {
  runId: string;
  dir: string;
}

/**
 * Resolve a run reference to a concrete directory under `runsRoot`.
 * Accepts:
 *   - "latest" / "last" → most recently modified subdirectory (skipping symlink).
 *   - any literal run-id present on disk.
 */
export function resolveRunDir(runsRoot: string, ref: string): RunLocation {
  if (!fs.existsSync(runsRoot)) {
    throw new Error(`eval runs root not found: ${runsRoot}`);
  }
  if (ref === "latest" || ref === "last") {
    const link = path.join(runsRoot, "latest");
    try {
      const target = fs.readlinkSync(link);
      const id = path.basename(target);
      const dir = path.isAbsolute(target) ? target : path.join(runsRoot, target);
      if (fs.existsSync(dir)) return { runId: id, dir };
    } catch {
      // fall through to directory scan
    }
    const sentinel = `${link}.txt`;
    if (fs.existsSync(sentinel)) {
      const id = fs.readFileSync(sentinel, "utf8").trim();
      const dir = path.join(runsRoot, id);
      if (fs.existsSync(dir)) return { runId: id, dir };
    }
    const ids = listRunIds(runsRoot);
    if (ids.length === 0) throw new Error(`no eval runs under ${runsRoot}`);
    const id = ids[ids.length - 1]!;
    return { runId: id, dir: path.join(runsRoot, id) };
  }
  const dir = path.join(runsRoot, ref);
  if (!fs.existsSync(dir)) throw new Error(`eval run not found: ${dir}`);
  return { runId: ref, dir };
}

/** Sorted oldest-first list of run-id directories (excludes `latest` symlink). */
export function listRunIds(runsRoot: string): string[] {
  if (!fs.existsSync(runsRoot)) return [];
  const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (e.name === "latest") continue;
    if (!e.isDirectory()) continue;
    if (!fs.existsSync(path.join(runsRoot, e.name, "eval-result.json"))) continue;
    ids.push(e.name);
  }
  ids.sort();
  return ids;
}

export function loadCaseResults(runDir: string): EvalCaseResult[] {
  const file = path.join(runDir, "case-results.jsonl");
  if (!fs.existsSync(file)) {
    throw new Error(`case-results.jsonl missing in ${runDir}`);
  }
  const raw = fs.readFileSync(file, "utf8");
  const out: EvalCaseResult[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as EvalCaseResult);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export function loadEvalRunResult(runDir: string): EvalRunResult {
  const file = path.join(runDir, "eval-result.json");
  if (!fs.existsSync(file)) {
    throw new Error(`eval-result.json missing in ${runDir}`);
  }
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as EvalRunResult;
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    throw new Error(`unsupported eval-result schemaVersion in ${file}: ${String(parsed.schemaVersion)}`);
  }
  if (parsed.schemaVersion === 2 && !parsed.inputs?.suiteFingerprint) {
    throw new Error(`schemaVersion 2 eval-result is missing inputs.suiteFingerprint: ${file}`);
  }
  return parsed;
}

/** Fingerprint canonical case definitions and every transitive fixture/probe file. */
export function fingerprintEvalCases(cases: EvalCase[], suiteDir?: string): string {
  const definitions = cases.map((evalCase) => canonicalize(evalCase));
  const files: Array<{ path: string; byteSize: number; sha256: string }> = [];

  if (suiteDir) {
    for (const evalCase of cases) {
      for (const key of ["fixture", "probesDir"] as const) {
        const value = evalCase.input[key];
        if (typeof value !== "string" || !value.trim()) continue;
        const dependency = path.isAbsolute(value) ? value : path.join(suiteDir, value);
        collectDependencyFiles(dependency, `${evalCase.id}/${key}`, files);
      }
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = canonicalize({ format: "akm-eval-suite-fingerprint-v2", definitions, files });
  return crypto.createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = canonicalize(child);
  }
  return out;
}

function collectDependencyFiles(
  dependency: string,
  manifestRoot: string,
  files: Array<{ path: string; byteSize: number; sha256: string }>,
): void {
  if (!fs.existsSync(dependency)) {
    throw new Error(`suite fingerprint dependency not found: ${dependency}`);
  }
  const stat = fs.lstatSync(dependency);
  if (stat.isSymbolicLink()) {
    throw new Error(`suite fingerprint dependency must not be a symbolic link: ${dependency}`);
  }
  if (stat.isFile()) {
    const bytes = fs.readFileSync(dependency);
    files.push({ path: manifestRoot, byteSize: bytes.length, sha256: sha256(bytes) });
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(dependency, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    collectDependencyFiles(path.join(dependency, entry.name), `${manifestRoot}/${entry.name}`, files);
  }
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Fail closed when two persisted runs do not prove they used the same suite. */
export function assertMatchingSuiteFingerprints(
  baselineFingerprint: string | undefined,
  currentFingerprint: string | undefined,
): void {
  if (!baselineFingerprint || !currentFingerprint) {
    throw new Error("suite fingerprint unavailable; regenerate both eval runs before comparing them");
  }
  if (baselineFingerprint !== currentFingerprint) {
    throw new Error(
      `suite fingerprint mismatch: baseline=${baselineFingerprint} current=${currentFingerprint}`,
    );
  }
}
