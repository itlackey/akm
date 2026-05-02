/**
 * akm-bench verifier dispatcher (spec §5.3).
 *
 *   • `script` — spawn `<taskDir>/verify.sh` with cwd = workspace.
 *   • `pytest` — spawn `pytest -q --tb=line` with cwd = workspace.
 *   • `regex`  — match `expected_match` against `agentStdout`.
 *
 * No LLM-as-judge anywhere. Static dispatch only.
 *
 * Missing runtime (e.g. `pytest` not on PATH) returns exit code 127 with a
 * clear stdout message. The driver maps that to `outcome: "harness_error"`,
 * NOT `fail` — a missing tool is not an agent failure.
 */

import fs from "node:fs";
import path from "node:path";

import type { SpawnFn } from "../../src/integrations/agent/spawn";

export type VerifierKind = "script" | "pytest" | "regex";

export interface VerifierConfig {
  /** Forwarded as the regex test input when `kind === "regex"`. */
  agentStdout?: string;
  /** Forwarded as the regex pattern when `kind === "regex"`. */
  expectedMatch?: string;
  /** Inject a fake spawn for unit tests; defaults to `Bun.spawn`. */
  spawn?: SpawnFn;
}

export interface VerifierResult {
  exitCode: number;
  stdout: string;
}

function resolveSpawn(config: VerifierConfig | undefined): SpawnFn {
  if (config?.spawn) return config.spawn;
  const bun = (globalThis as { Bun?: { spawn: SpawnFn } }).Bun;
  if (!bun?.spawn) throw new Error("Bun.spawn unavailable; pass config.spawn");
  return bun.spawn.bind(bun);
}

async function readStream(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

async function runProcess(cmd: string[], cwd: string, spawn: SpawnFn): Promise<VerifierResult> {
  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ENOENT (binary missing) maps to 127 — the conventional "command not found".
    return {
      exitCode: 127,
      stdout: `verifier failed to spawn: ${message}`,
    };
  }

  const stdoutPromise = readStream(proc.stdout ?? null);
  const stderrPromise = readStream(proc.stderr ?? null);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 127,
      stdout: `verifier exited with error: ${message}`,
    };
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  // Combine stdout+stderr so the operator sees the full verifier output.
  const combined = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
  return { exitCode, stdout: combined };
}

/**
 * Dispatch a verifier run. Each branch maps a `task.yaml` `verifier:` field
 * onto a deterministic check.
 */
export async function runVerifier(
  taskDir: string,
  workspace: string,
  kind: VerifierKind,
  config?: VerifierConfig,
): Promise<VerifierResult> {
  if (kind === "script") {
    const script = path.join(taskDir, "verify.sh");
    if (!fs.existsSync(script)) {
      return { exitCode: 127, stdout: `verify.sh not found at ${script}` };
    }
    return runProcess(["bash", script], workspace, resolveSpawn(config));
  }

  if (kind === "pytest") {
    // Test files live at <taskDir>/tests/, not inside the workspace copy.
    // Pass the absolute path so pytest discovers them while running with
    // cwd=workspace (which lets relative paths like pathlib.Path("file.yml") work).
    const testsDir = path.join(taskDir, "tests");
    const testArgs = fs.existsSync(testsDir) ? [testsDir] : [];
    return runProcess(["pytest", "-q", "--tb=line", ...testArgs], workspace, resolveSpawn(config));
  }

  if (kind === "regex") {
    const pattern = config?.expectedMatch;
    const input = config?.agentStdout ?? "";
    if (!pattern) {
      return {
        exitCode: 127,
        stdout: 'regex verifier requires "expected_match" in task.yaml',
      };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { exitCode: 127, stdout: `invalid regex: ${message}` };
    }
    const matched = regex.test(input);
    return {
      exitCode: matched ? 0 : 1,
      stdout: matched ? `regex match: ${pattern}` : `regex did not match: ${pattern}`,
    };
  }

  // Compiler should refuse to land an unknown kind; runtime guard is belt-and-braces.
  return { exitCode: 127, stdout: `unknown verifier kind: ${String(kind)}` };
}
