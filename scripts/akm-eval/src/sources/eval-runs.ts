/**
 * Resolver + loader for completed eval-run directories under
 * `<stash>/.akm/evals/runs/`.
 *
 * Centralises "latest" handling and case-results.jsonl parsing so the
 * regression runner, compare command, and trend command don't each
 * reinvent it.
 */

import fs from "node:fs";
import path from "node:path";
import type { EvalCaseResult, EvalRunResult } from "../types";

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
    const id = ids[ids.length - 1];
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
  return JSON.parse(raw) as EvalRunResult;
}
