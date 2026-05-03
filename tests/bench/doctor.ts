/**
 * bench doctor — pre-flight harness smoke-test.
 *
 * Runs a sequence of checks that surface misconfiguration issues before a
 * full bench run. Each check is independent and produces a structured result.
 * The most important check (#3) materialises a real isolation dir, writes the
 * opencode.json exactly as `runOne` does, and runs a live `opencode run`
 * invocation with a 60-second timeout. This catches the class of silent
 * harness bugs (wrong OPENCODE_CONFIG path, missing model key, wrong
 * subcommand, blocked node_modules, open stdin pipe) in a single shot.
 *
 * Usage from the CLI:
 *   bun run tests/bench/cli.ts doctor [--model <id>] [--opencode-config <path>] [--verbose]
 *
 * Exit codes: 0 = all checks pass, 1 = any check failed.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getBuiltinAgentProfile } from "../../src/integrations/agent/profiles";
import { runAgent } from "../../src/integrations/agent/spawn";
import { buildIsolatedEnv, buildSanitizedEnvSource, createIsolationDirs } from "./driver";
import { BENCH_OPENCODE_INVARIANTS, validateFixtureCorpus, writeOpencodeJson } from "./environment";
import { BenchConfigError, type LoadedOpencodeProviders, selectProviderForModel } from "./opencode-config";
import { benchMkdtemp } from "./tmp";

// Re-export for external consumers.
export type { LoadedOpencodeProviders };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** "warn" means the check found something non-fatal; "pass"/"fail" are normal. */
  severity: "pass" | "fail" | "warn";
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Absolute path to the repo root (two directories above tests/bench). */
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Absolute path to the az-cli fixture stash. */
const AZ_CLI_FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "stashes", "az-cli");

/** akm binary — the same one the bench would use in a real run. */
function resolveAkmBin(): string {
  // Try explicit PATH lookup first so the local `bun run` path works too.
  const result = Bun.spawnSync({ cmd: ["which", "akm"], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode === 0) {
    const bin = new TextDecoder().decode(result.stdout).trim();
    if (bin) return bin;
  }
  // Fallback: project-local bin via bun (works in CI where akm isn't on PATH).
  return "akm";
}

function log(verbose: boolean, msg: string): void {
  if (verbose) process.stderr.write(`  [doctor] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

/**
 * Check 1: opencode binary is reachable on PATH.
 */
async function checkOpencodeReachable(verbose: boolean): Promise<DoctorCheck> {
  const name = "opencode binary reachable";
  log(verbose, `running check: ${name}`);
  try {
    const result = Bun.spawnSync({
      cmd: ["which", "opencode"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      const binPath = new TextDecoder().decode(result.stdout).trim();
      log(verbose, `opencode found at: ${binPath}`);
      return { name, ok: true, severity: "pass", message: `opencode found at ${binPath}` };
    }
    return {
      name,
      ok: false,
      severity: "fail",
      message: "opencode not found on PATH — install it with `npm install -g opencode-ai` or equivalent",
    };
  } catch (err) {
    return {
      name,
      ok: false,
      severity: "fail",
      message: `which opencode threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 2: model resolves against provider's /v1/models endpoint.
 *
 * For local providers that carry an explicit `options.baseURL`, makes an HTTP
 * GET to `${baseURL}/models` and checks that the model ID suffix is in the
 * response. For built-in cloud models (no matching provider entry in the
 * providers file) the check is skipped — we can't probe without auth.
 */
async function checkModelResolves(
  model: string,
  opencodeProviders: LoadedOpencodeProviders | undefined,
  verbose: boolean,
): Promise<DoctorCheck> {
  const name = "model resolves";
  log(verbose, `running check: ${name} (model=${model})`);

  if (!opencodeProviders) {
    return {
      name,
      ok: true,
      severity: "pass",
      message: "no local provider config; model will be resolved by opencode's cloud-provider defaults (skipped probe)",
    };
  }

  let selected: { providerKey: string; entry: unknown };
  try {
    selected = selectProviderForModel(opencodeProviders, model);
  } catch (err) {
    if (err instanceof BenchConfigError) {
      // Model has no provider entry — likely a built-in cloud model. Skip.
      return {
        name,
        ok: true,
        severity: "pass",
        message: `model "${model}" has no provider entry (built-in cloud model) — skipping HTTP probe`,
      };
    }
    return {
      name,
      ok: false,
      severity: "fail",
      message: `selectProviderForModel threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Extract baseURL from the provider entry to know where to probe.
  const entry = selected.entry as Record<string, unknown>;
  const options = entry.options as Record<string, unknown> | undefined;
  const baseURL = typeof options?.baseURL === "string" ? options.baseURL : undefined;

  if (!baseURL) {
    return {
      name,
      ok: true,
      severity: "pass",
      message: `provider "${selected.providerKey}" has no baseURL — cannot probe without auth (skipped)`,
    };
  }

  // The model suffix is everything after the first "/" (the provider key).
  const slashIdx = model.indexOf("/");
  const modelSuffix = slashIdx === -1 ? model : model.slice(slashIdx + 1);

  log(verbose, `probing ${baseURL}/models for model suffix "${modelSuffix}"`);

  try {
    // Trim trailing slash so we don't end up with double slashes.
    const url = `${baseURL.replace(/\/$/, "")}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      return {
        name,
        ok: false,
        severity: "fail",
        message: `GET ${url} returned HTTP ${resp.status} — is the local LLM server running?`,
      };
    }

    const body = (await resp.json()) as { data?: Array<{ id: string }> };
    const ids = (body.data ?? []).map((m) => m.id);
    log(verbose, `models returned: ${ids.join(", ")}`);

    // Check if the model suffix (or the full model id) appears in the list.
    const found = ids.some((id) => id === modelSuffix || id === model);
    if (found) {
      return { name, ok: true, severity: "pass", message: `model "${modelSuffix}" found in ${url}` };
    }
    return {
      name,
      ok: false,
      severity: "fail",
      message: `model "${modelSuffix}" not found in ${url}; available: ${ids.join(", ") || "(none)"}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = msg.includes("abort") || msg.includes("AbortError");
    return {
      name,
      ok: false,
      severity: "fail",
      message: isAbort
        ? `GET ${baseURL}/models timed out after 10 s — is the local LLM server running?`
        : `GET ${baseURL}/models failed: ${msg}`,
    };
  }
}

/**
 * Check 3: materialise + run — the single most important check.
 *
 * Creates a real isolation dir, materialises opencode.json exactly as `runOne`
 * does, then runs:
 *
 *   opencode run "Reply with the single word: READY" --model <model>
 *
 * with a 60 s timeout. Checks that stdout contains "READY" (case-insensitive).
 * This catches all of: wrong OPENCODE_CONFIG path, missing model key, wrong
 * subcommand, blocked node_modules, open stdin pipe.
 */
async function checkMaterialiseAndRun(
  model: string,
  opencodeProviders: LoadedOpencodeProviders | undefined,
  verbose: boolean,
): Promise<DoctorCheck> {
  const name = "materialise + run";
  log(verbose, `running check: ${name}`);

  const workspace = benchMkdtemp("bench-doctor-run-");
  const dirs = createIsolationDirs(undefined);

  try {
    // Materialise opencode.json using the same writer as runOne. Warnings
    // (e.g. built-in cloud model stub) are surfaced via verbose log only.
    const writeResult = writeOpencodeJson(dirs.opencodeConfig, model, opencodeProviders);
    for (const w of writeResult.warnings) log(verbose, `writeOpencodeJson: ${w}`);
    if (writeResult.providerKey) {
      log(verbose, `materialised opencode.json with provider "${writeResult.providerKey}"`);
    } else {
      log(verbose, "no provider entry for model — wrote stub opencode.json with bench invariants");
    }

    const env = buildIsolatedEnv(dirs, model);
    log(verbose, `OPENCODE_CONFIG=${env.OPENCODE_CONFIG}`);
    log(verbose, `XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`);

    const profile = getBuiltinAgentProfile("opencode");
    if (!profile) {
      return {
        name,
        ok: false,
        severity: "fail",
        message: 'built-in agent profile "opencode" not found — this is a harness bug',
      };
    }

    const prompt = "Reply with the single word: READY";
    log(verbose, `spawning opencode with prompt: "${prompt}"`);

    const agentResult = await runAgent(profile, prompt, {
      env,
      envSource: buildSanitizedEnvSource(),
      cwd: workspace,
      timeoutMs: 60_000,
      stdio: "captured",
    });

    log(verbose, `opencode exited: ok=${agentResult.ok}, reason=${agentResult.reason ?? "none"}`);
    if (verbose && agentResult.stdout) {
      const preview = agentResult.stdout.slice(0, 500);
      process.stderr.write(`  [doctor] stdout preview: ${preview}\n`);
    }

    if (!agentResult.ok) {
      if (agentResult.reason === "timeout") {
        return {
          name,
          ok: false,
          severity: "fail",
          message: "opencode timed out after 60 s — check model availability and provider config",
        };
      }
      if (agentResult.reason === "spawn_failed") {
        return {
          name,
          ok: false,
          severity: "fail",
          message: "opencode failed to spawn — is `opencode` on PATH and executable?",
        };
      }
      // non_zero_exit is still OK to check stdout for READY.
    }

    const containsReady = /ready/i.test(agentResult.stdout);
    if (containsReady) {
      return {
        name,
        ok: true,
        severity: "pass",
        message: 'opencode replied with "READY" — config and model are functional',
      };
    }

    // Even if stdout doesn't contain "READY", a non-zero exit or unexpected
    // output is still a failure for our purposes.
    const stdoutSnip = agentResult.stdout.slice(0, 300).replace(/\n/g, " ").trim();
    return {
      name,
      ok: false,
      severity: "fail",
      message: `opencode did not include "READY" in output. stdout: ${stdoutSnip || "(empty)"}`,
    };
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Check 4: stash fixture loadable.
 *
 * Runs `akm search az cli` with `AKM_STASH_DIR` pointing at the az-cli
 * fixture and confirms at least one result is returned. Verifies that akm
 * itself is functional in isolation.
 */
async function checkStashFixtureLoadable(verbose: boolean): Promise<DoctorCheck> {
  const name = "stash fixture loadable";
  log(verbose, `running check: ${name}`);

  if (!fs.existsSync(AZ_CLI_FIXTURE)) {
    return {
      name,
      ok: false,
      severity: "fail",
      message: `az-cli fixture stash not found at: ${AZ_CLI_FIXTURE}`,
    };
  }

  const akmBin = resolveAkmBin();
  log(verbose, `using akm binary: ${akmBin}`);

  try {
    const result = Bun.spawnSync({
      cmd: [akmBin, "search", "az", "cli"],
      env: { ...process.env, AKM_STASH_DIR: AZ_CLI_FIXTURE },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new TextDecoder().decode(result.stdout ?? new Uint8Array());
    const stderr = new TextDecoder().decode(result.stderr ?? new Uint8Array());
    log(verbose, `akm search exit: ${result.exitCode}, stdout length: ${stdout.length}`);
    if (verbose && stderr) {
      process.stderr.write(`  [doctor] akm search stderr: ${stderr.slice(0, 200)}\n`);
    }

    // Check for at least one result. The search command outputs asset refs or
    // formatted results. An empty output or a "no results" message is a fail.
    const hasResults =
      result.exitCode === 0 &&
      stdout.trim().length > 0 &&
      !stdout.toLowerCase().includes("no results") &&
      !stdout.toLowerCase().includes("0 results");

    if (hasResults) {
      const lineCount = stdout.trim().split("\n").length;
      return {
        name,
        ok: true,
        severity: "pass",
        message: `akm search returned ${lineCount} result line(s) from az-cli fixture`,
      };
    }

    return {
      name,
      ok: false,
      severity: "fail",
      message: `akm search az cli returned no results (exit=${result.exitCode}). stdout: ${stdout.slice(0, 200).trim() || "(empty)"}`,
    };
  } catch (err) {
    return {
      name,
      ok: false,
      severity: "fail",
      message: `akm search threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 5: verifier binaries present.
 *
 * Checks that `bash` is on PATH (required for script verifiers). Optionally
 * checks for `pytest` (required for pytest verifiers). Missing `pytest` is a
 * warning, not a failure.
 */
async function checkVerifierBinaries(verbose: boolean): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // bash
  {
    const name = "verifier: bash present";
    log(verbose, `running check: ${name}`);
    const result = Bun.spawnSync({ cmd: ["which", "bash"], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      const p = new TextDecoder().decode(result.stdout).trim();
      checks.push({ name, ok: true, severity: "pass", message: `bash found at ${p}` });
    } else {
      checks.push({
        name,
        ok: false,
        severity: "fail",
        message: "bash not found on PATH — script verifiers will fail with exit 127",
      });
    }
  }

  // pytest
  {
    const name = "verifier: pytest present";
    log(verbose, `running check: ${name}`);
    const result = Bun.spawnSync({ cmd: ["which", "pytest"], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      const p = new TextDecoder().decode(result.stdout).trim();
      checks.push({ name, ok: true, severity: "pass", message: `pytest found at ${p}` });
    } else {
      // Warn but don't fail — only pytest-verifier tasks need it.
      checks.push({
        name,
        ok: true,
        severity: "warn",
        message: "pytest not found on PATH — tasks with verifier: pytest will fail with exit 127",
      });
    }
  }

  return checks;
}

/**
 * Check 6: generated opencode.json carries bench isolation invariants.
 *
 * Materialises an opencode.json exactly as runOne does and asserts that
 * `plugin` is an empty array and `permission.bash === "allow"`. Catches
 * any refactor that accidentally drops these fields.
 */
async function checkOpencodeJsonInvariants(
  model: string,
  opencodeProviders: LoadedOpencodeProviders | undefined,
  verbose: boolean,
): Promise<DoctorCheck> {
  const name = "opencode.json bench invariants";
  log(verbose, `running check: ${name}`);

  const tmpDir = benchMkdtemp("bench-doctor-invariant-");
  try {
    fs.mkdirSync(path.join(tmpDir, "opencode-config"), { recursive: true });
    writeOpencodeJson(path.join(tmpDir, "opencode-config"), model, opencodeProviders);

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "opencode-config", "opencode.json"), "utf8"),
    ) as Record<string, unknown>;

    const pluginOk = Array.isArray(written.plugin) && written.plugin.length === 0;
    const permOk =
      written.permission !== null &&
      typeof written.permission === "object" &&
      (written.permission as Record<string, unknown>).bash === "allow";

    if (pluginOk && permOk) {
      return { name, ok: true, severity: "pass", message: "plugin:[] and permission.bash=allow present" };
    }

    const issues: string[] = [];
    if (!pluginOk) issues.push(`plugin=${JSON.stringify(written.plugin)} (expected [])`);
    if (!permOk)
      issues.push(
        `permission.bash=${JSON.stringify((written.permission as Record<string, unknown>)?.bash)} (expected "allow")`,
      );
    return { name, ok: false, severity: "fail", message: `invariant violation: ${issues.join("; ")}` };
  } catch (err) {
    return {
      name,
      ok: false,
      severity: "fail",
      message: `invariant check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Check 7 (optional): all task stash references name valid fixtures.
 *
 * When `tasks` is provided, validates every `task.stash` against the
 * fixture directory. Missing fixtures produce `harness_error` at run time —
 * better to surface them loudly at startup.
 */
function checkFixtureCorpus(tasks: ReadonlyArray<{ id: string; stash: string }>, verbose: boolean): DoctorCheck {
  const name = "fixture corpus";
  log(verbose, `running check: ${name}`);

  const { valid, missing } = validateFixtureCorpus(tasks);
  if (missing.size === 0) {
    return { name, ok: true, severity: "pass", message: `all ${valid.size} fixture(s) found` };
  }

  const detail = [...missing.entries()].map(([fix, tids]) => `${fix} (used by: ${tids.join(", ")})`).join("; ");
  return {
    name,
    ok: false,
    severity: "fail",
    message: `${missing.size} fixture(s) missing MANIFEST.json: ${detail}`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  /** The model to test (e.g. "don/mlx-community/qwen3.6-35b-a3b"). */
  model: string;
  /** Pre-loaded opencode provider config (from auto-discovery). */
  opencodeProviders?: LoadedOpencodeProviders;
  /** Emit detailed diagnostic output to stderr. */
  verbose?: boolean;
  /** When supplied, check 7 validates all stash references. */
  tasks?: ReadonlyArray<{ id: string; stash: string }>;
}

/**
 * Run all doctor checks in order. Returns a structured `DoctorResult`.
 *
 * Fails fast on check 1 (opencode binary missing) since subsequent checks
 * that invoke opencode would also fail in a confusing way.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const { model, opencodeProviders, verbose = false, tasks } = options;
  const allChecks: DoctorCheck[] = [];

  if (verbose) {
    process.stderr.write(`[bench doctor] model=${model}\n`);
    if (opencodeProviders) {
      process.stderr.write(`[bench doctor] providers loaded from: ${opencodeProviders.source}\n`);
    } else {
      process.stderr.write("[bench doctor] no providers config (cloud-provider defaults)\n");
    }
    process.stderr.write("\n");
  }

  // ── Check 1: opencode binary ──────────────────────────────────────────────
  const check1 = await checkOpencodeReachable(verbose);
  allChecks.push(check1);
  if (!check1.ok) {
    // Fail fast: subsequent checks that spawn opencode will produce confusing
    // errors. Short-circuit with the remaining checks as skipped.
    process.stderr.write("[bench doctor] FAIL FAST: opencode not found — skipping remaining checks\n");
    return { ok: false, checks: allChecks };
  }

  // ── Check 2: model resolves ───────────────────────────────────────────────
  allChecks.push(await checkModelResolves(model, opencodeProviders, verbose));

  // ── Check 3: materialise + run ────────────────────────────────────────────
  allChecks.push(await checkMaterialiseAndRun(model, opencodeProviders, verbose));

  // ── Check 4: stash fixture loadable ──────────────────────────────────────
  allChecks.push(await checkStashFixtureLoadable(verbose));

  // ── Check 5: verifier binaries ────────────────────────────────────────────
  allChecks.push(...(await checkVerifierBinaries(verbose)));

  // ── Check 6: opencode.json invariants ─────────────────────────────────────
  allChecks.push(await checkOpencodeJsonInvariants(model, opencodeProviders, verbose));

  // ── Check 7 (optional): fixture corpus ───────────────────────────────────
  if (tasks && tasks.length > 0) {
    allChecks.push(checkFixtureCorpus(tasks, verbose));
  }

  // overall ok = no "fail" severity checks (warns are ok)
  const ok = allChecks.every((c) => c.severity !== "fail");
  return { ok, checks: allChecks };
}

// ---------------------------------------------------------------------------
// Formatting helper (used by the CLI)
// ---------------------------------------------------------------------------

/**
 * Render a `DoctorResult` as a human-readable report string. Written to
 * stderr by the CLI dispatcher.
 */
export function renderDoctorReport(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push("## bench doctor\n");
  for (const c of result.checks) {
    const icon = c.severity === "pass" ? "PASS" : c.severity === "warn" ? "WARN" : "FAIL";
    lines.push(`  [${icon}] ${c.name}: ${c.message}`);
  }
  lines.push("");
  lines.push(
    result.ok ? "All checks passed — harness is ready." : "One or more checks FAILED — fix before running bench.",
  );
  return lines.join("\n");
}
