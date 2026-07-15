/**
 * Judge-calibration runner (Phase 4, R3).
 *
 * Measures the distill judge's agreement with hand-graded probes and its
 * variance across resamples. MT-Bench (arXiv:2306.05685) reports ~±0.5 judge
 * variance; D-5 / #388 introduced the `review_needed` band specifically to
 * absorb that wobble. This runner makes that variance measurable.
 *
 * Probe shape (see cases/judge-calibration/probes/*.json):
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "id": "probe-001",
 *   "assetType": "memory" | "skill" | "lesson",
 *   "assetRef": "memory:probe-001",
 *   "asset": {
 *     "frontmatter": { ... },
 *     "body": "..."
 *   },
 *   "feedback": [
 *     { "ts": "...", "signal": "positive"|"negative", "reason": "...", "note": "..." }
 *   ],
 *   "humanGrade": {
 *     "expectedOutcome": "queued" | "review_needed" | "quality_rejected" | "validation_failed",
 *     "expectedScoreBand": [low, high],
 *     "rationale": "..."
 *   }
 * }
 * ```
 *
 * Procedure per probe:
 *   1. Build a fresh sandbox via `createSandbox()`.
 *   2. Materialize the probe asset file at <sandbox>/<stashDir>/<name>.md
 *      (or skills/<name>/SKILL.md for skills).
 *   3. Run `akm feedback <ref> ...` once per feedback event.
 *   4. Run `akm index` to refresh embeddings.
 *   5. Run `akm improve --json-to-stdout` and harvest the latest
 *      `distill_invoked` event for the probe's ref from state.db.
 *   6. Cleanup the sandbox.
 *   7. Repeat `samplesPerProbe` times so cross-resample variance is
 *      measurable (mode-count / N).
 *
 * Output:
 *   - `metrics`: per-probe + aggregate (agreement rate, median variance,
 *     flip rate, per-band counts). Hoisted to envelope.metrics.judgeCalibration
 *     by `run.ts`.
 *   - `score`: linear blend of agreement (0.6) and inverse variance (0.4).
 *
 * The harness writes a sandbox-local distill-only improve profile using the
 * current `profiles.improve.default.processes.*` shape. When the outer env has
 * no resolvable LLM path (`defaults.llm` / `profiles.llm`), the case is
 * skipped with an actionable precondition instead of generating stale all-
 * `skipped` disagreement noise.
 */

import fs from "node:fs";
import path from "node:path";

import { AkmCli } from "../sources/akm-cli";
import { createSandbox } from "../sources/sandbox";
import { StateDbSources, type EventRow } from "../sources/state-db";
import type { EvalCase, EvalCaseResult, EvalContext } from "../types";

type HumanGradedOutcome =
  | "queued"
  | "review_needed"
  | "quality_rejected"
  | "validation_failed";

// Match the realized outcomes emitted by src/commands/improve/distill.ts.
// Duplicated here because the toolkit MUST NOT import akm internals.
type DistillProbeOutcome =
  | HumanGradedOutcome
  | "skipped"
  | "config_disabled"
  | "llm_failed";

export interface JudgeCalibrationSandboxConfigResolution {
  ok: boolean;
  sourceConfigPath?: string;
  config?: Record<string, unknown>;
  reason?: string;
}

const HUMAN_GRADED_OUTCOMES: HumanGradedOutcome[] = [
  "queued",
  "review_needed",
  "quality_rejected",
  "validation_failed",
];

interface ProbeFeedback {
  ts?: string;
  signal: "positive" | "negative";
  reason?: string;
  note?: string;
  failureMode?: string;
}

interface ProbeFile {
  schemaVersion: 1;
  id: string;
  assetType: "memory" | "skill" | "lesson";
  assetRef: string;
  asset: {
    frontmatter?: Record<string, unknown>;
    body?: string;
  };
  feedback: ProbeFeedback[];
  humanGrade: {
    expectedOutcome: HumanGradedOutcome;
    expectedScoreBand?: [number, number];
    rationale?: string;
  };
}

interface PerProbeMetric {
  probeId: string;
  assetRef: string;
  expected: HumanGradedOutcome;
  actual: DistillProbeOutcome[];
  agreementCount: number;
  variance: number;
  scoreSamples: number[];
  scoreBandMatch: number; // 0..1 — fraction of samples whose judge score falls in expectedScoreBand
  errors: string[];
}

interface JudgeCalibrationMetrics {
  totalProbes: number;
  samplesPerProbe: number;
  agreementRate: number;
  perBand: Record<HumanGradedOutcome, { probes: number; agreedSamples: number; rate: number }>;
  medianVariance: number;
  meanVariance: number;
  flipRate: number;
  perProbe: Array<{
    probeId: string;
    expected: HumanGradedOutcome;
    actual: DistillProbeOutcome[];
    agreementCount: number;
    variance: number;
  }>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function collectConfigCandidates(env: Record<string, string>): string[] {
  const candidates: string[] = [];
  const push = (candidate: string | undefined): void => {
    if (!candidate || candidates.includes(candidate)) return;
    candidates.push(candidate);
  };

  const akmConfigDir = asNonEmptyString(env.AKM_CONFIG_DIR);
  if (akmConfigDir) push(path.join(akmConfigDir, "config.json"));

  const xdgConfigHome = asNonEmptyString(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) push(path.join(xdgConfigHome, "akm", "config.json"));

  const stashDir = asNonEmptyString(env.AKM_STASH_DIR);
  if (stashDir) push(path.join(stashDir, ".akm", "config.json"));

  const home = asNonEmptyString(env.HOME);
  if (home) push(path.join(home, ".config", "akm", "config.json"));

  return candidates;
}

function resolveDefaultLlmProfileNameFromConfig(config: Record<string, unknown>): string | undefined {
  const defaults = config.defaults;
  if (defaults && typeof defaults === "object") {
    const explicit = asNonEmptyString((defaults as Record<string, unknown>).llm);
    if (explicit) return explicit;
  }
  const profiles = config.profiles;
  if (!profiles || typeof profiles !== "object") return undefined;
  const llmProfiles = (profiles as Record<string, unknown>).llm;
  if (!llmProfiles || typeof llmProfiles !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(llmProfiles, "default") ? "default" : undefined;
}

function collectEnvReferences(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const envRef = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    const name = envRef?.[1] ?? envRef?.[2];
    if (name) out.add(name);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvReferences(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) collectEnvReferences(child, out);
}

function collectSandboxSecrets(config: Record<string, unknown>, env: Record<string, string>): Record<string, string> {
  const needed = new Set<string>();
  collectEnvReferences(config, needed);
  const copied: Record<string, string> = {};
  for (const name of needed) {
    const value = env[name];
    if (typeof value === "string" && value !== "") copied[name] = value;
  }
  return copied;
}

export function resolveJudgeCalibrationSandboxConfig(
  env: Record<string, string>,
): JudgeCalibrationSandboxConfigResolution {
  for (const configPath of collectConfigCandidates(env)) {
    if (!fs.existsSync(configPath)) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        reason: `judge-calibration could not parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const llmProfileName = resolveDefaultLlmProfileNameFromConfig(parsed);
    if (!llmProfileName) {
      return {
        ok: false,
        reason:
          `judge-calibration requires an LLM path. ${configPath} does not define ` +
          "`defaults.llm` (or an implicit `profiles.llm.default`). Configure a default LLM profile and re-run.",
      };
    }

    const llmProfiles = (parsed.profiles as Record<string, unknown> | undefined)?.llm;
    const llmConfig = llmProfiles && typeof llmProfiles === "object" ? (llmProfiles as Record<string, unknown>)[llmProfileName] : undefined;
    if (!llmConfig || typeof llmConfig !== "object") {
      return {
        ok: false,
        reason:
          `judge-calibration requires an LLM path. ${configPath} points defaults.llm at ` +
          `"${llmProfileName}", but profiles.llm.${llmProfileName} is missing.`,
      };
    }

    return {
      ok: true,
      sourceConfigPath: configPath,
      config: {
        defaults: {
          llm: llmProfileName,
          improve: "default",
        },
        profiles: {
          llm: {
            [llmProfileName]: llmConfig,
          },
          improve: {
            default: {
              description: "judge-calibration distill-only sandbox profile",
              processes: {
                reflect: { enabled: false },
                distill: { enabled: true, allowedTypes: ["memory"], requirePlannedRefs: false },
                consolidate: { enabled: false },
                memoryInference: { enabled: false },
                graphExtraction: { enabled: false },
                extract: { enabled: false },
                proactiveMaintenance: { enabled: false },
                triage: { enabled: false },
                procedural: { enabled: false },
              },
              sync: { enabled: false, push: false },
            },
          },
        },
      },
    };
  }

  return {
    ok: false,
    reason:
      "judge-calibration requires an LLM path, but no AKM config with `defaults.llm` / `profiles.llm` was found in " +
      "AKM_CONFIG_DIR, XDG_CONFIG_HOME, AKM_STASH_DIR/.akm, or HOME/.config/akm. Configure an LLM profile, then re-run the suite.",
  };
}

function writeJudgeCalibrationSandboxConfig(sandboxRoot: string, config: Record<string, unknown>): string {
  const configDir = path.join(sandboxRoot, ".config", "akm");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

/** Resolve where a probe asset's file should live inside the sandboxed stash. */
function probeAssetPath(stashDir: string, p: ProbeFile): string {
  const parsed = parseRef(p.assetRef);
  if (parsed.type === "memory") return path.join(stashDir, "memories", `${parsed.name}.md`);
  if (parsed.type === "lesson") return path.join(stashDir, "lessons", `${parsed.name}.md`);
  if (parsed.type === "skill") return path.join(stashDir, "skills", parsed.name, "SKILL.md");
  throw new Error(`probe asset type not supported: ${parsed.type}`);
}

function parseRef(ref: string): { type: string; name: string } {
  const m = ref.match(/^([a-z]+):(.+)$/);
  if (!m) throw new Error(`invalid asset ref: ${ref}`);
  return { type: m[1], name: m[2] };
}

/**
 * Render YAML-ish frontmatter from a probe's `frontmatter` object. Same
 * scalar/list scope as the memory-safety runner's parser — no nested objects
 * (the probe schema documents the flat layout).
 */
function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      const inline = value.map((v) => JSON.stringify(String(v))).join(", ");
      lines.push(`${key}: [${inline}]`);
    } else if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else if (typeof value === "boolean" || typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      // Quote strings that contain reserved chars; bare scalars otherwise.
      const s = String(value);
      if (/[:#"'\n]/.test(s)) lines.push(`${key}: ${JSON.stringify(s)}`);
      else lines.push(`${key}: ${s}`);
    }
  }
  return lines.join("\n");
}

/** Write the probe's asset to disk verbatim — frontmatter then body. */
function materializeProbeAsset(stashDir: string, p: ProbeFile): string {
  const filePath = probeAssetPath(stashDir, p);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fm = renderFrontmatter(p.asset.frontmatter ?? {});
  const body = (p.asset.body ?? "").replace(/\s+$/, "");
  const contents = fm ? `---\n${fm}\n---\n\n${body}\n` : `${body}\n`;
  fs.writeFileSync(filePath, contents);
  return filePath;
}

/** Load every *.json probe file under <probesDir>, sorted by filename. */
function loadProbes(probesDir: string): ProbeFile[] {
  if (!fs.existsSync(probesDir)) {
    throw new Error(`probes dir not found: ${probesDir}`);
  }
  const files = fs
    .readdirSync(probesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const out: ProbeFile[] = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(probesDir, f), "utf8");
    let parsed: ProbeFile;
    try {
      parsed = JSON.parse(raw) as ProbeFile;
    } catch (err) {
      throw new Error(`invalid probe JSON ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.schemaVersion !== 1) {
      throw new Error(`probe ${f} has unsupported schemaVersion ${parsed.schemaVersion}`);
    }
    if (!parsed.id || !parsed.assetRef || !parsed.humanGrade?.expectedOutcome) {
      throw new Error(`probe ${f} missing required fields (id/assetRef/humanGrade.expectedOutcome)`);
    }
    if (!HUMAN_GRADED_OUTCOMES.includes(parsed.humanGrade.expectedOutcome)) {
      throw new Error(
        `probe ${f} expectedOutcome must be one of ${HUMAN_GRADED_OUTCOMES.join(", ")} (got ${parsed.humanGrade.expectedOutcome})`,
      );
    }
    out.push(parsed);
  }
  return out;
}

/**
 * Read the latest `distill_invoked` event for `ref` from the sandboxed
 * state.db. Returns undefined when no event was emitted (e.g. the judge
 * never ran because the feature gate is off and improve fell through the
 * config_disabled branch without `distill_invoked`).
 */
function readLatestDistillEvent(dbPath: string, ref: string): EventRow | undefined {
  const db = new StateDbSources(dbPath);
  if (!db.available()) return undefined;
  try {
    const events = db.readEvents({ types: ["distill_invoked"], ref });
    if (events.length === 0) return undefined;
    return events[events.length - 1];
  } finally {
    db.close();
  }
}

/** Compute mode-count / N. Higher == more consistent; 1.0 means all samples agree. */
function modeFraction(samples: DistillProbeOutcome[]): number {
  if (samples.length === 0) return 0;
  const counts: Record<string, number> = {};
  for (const s of samples) counts[s] = (counts[s] ?? 0) + 1;
  const top = Math.max(...Object.values(counts));
  return top / samples.length;
}

/** Variance = 1 - mode-fraction (so 0 == all agree, 1 == perfectly split). */
function disagreementVariance(samples: DistillProbeOutcome[]): number {
  return 1 - modeFraction(samples);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

async function runProbeOnce(
  probe: ProbeFile,
  ctx: EvalContext,
  improveArgs: string[],
  sandboxConfig: Record<string, unknown>,
): Promise<{ outcome: DistillProbeOutcome; score?: number; reason?: string; errors: string[] }> {
  const errors: string[] = [];
  const sandbox = createSandbox({ prefix: "akm-eval-judge-", inheritEnv: true });
  try {
    const configPath = writeJudgeCalibrationSandboxConfig(sandbox.root, sandboxConfig);
    sandbox.env.AKM_CONFIG_DIR = path.dirname(configPath);
    Object.assign(sandbox.env, collectSandboxSecrets(sandboxConfig, ctx.env));

    // Materialize the probe asset.
    materializeProbeAsset(sandbox.stashDir, probe);

    const cli = new AkmCli(ctx.akmBin, sandbox.env);

    // Index FIRST so the asset enters the index before feedback (`akm
    // feedback` rejects refs that aren't indexed).
    const idx0 = cli.index();
    if (idx0.status !== 0) {
      errors.push(`initial index failed (exit ${idx0.status}): ${idx0.stderr.trim().slice(0, 200)}`);
      errors.push(`sandbox config: ${configPath}`);
      return { outcome: "skipped", errors };
    }

    // Record each feedback event.
    for (const fb of probe.feedback ?? []) {
      const res = cli.feedback(probe.assetRef, {
        signal: fb.signal,
        reason: fb.reason ?? (fb.signal === "negative" ? "calibration probe" : undefined),
        note: fb.note,
        failureMode: fb.failureMode,
      });
      if (res.status !== 0) {
        errors.push(`feedback (${fb.signal}) failed (exit ${res.status}): ${res.stderr.trim().slice(0, 200)}`);
      }
    }

    // Re-index after feedback so utility scores are fresh for improve.
    const idx1 = cli.index();
    if (idx1.status !== 0) {
      errors.push(`post-feedback index failed (exit ${idx1.status}): ${idx1.stderr.trim().slice(0, 200)}`);
    }

    // Drive improve. We don't read the JSON envelope here — the durable
    // signal is the `distill_invoked` event in state.db.
    const imp = cli.improve(["--scope", probe.assetRef, "--json-to-stdout", ...improveArgs]);
    if (imp.status !== 0) {
      errors.push(`improve failed (exit ${imp.status}): ${imp.stderr.trim().slice(0, 200)}`);
      // Even on non-zero exit a distill_invoked event may have been written
      // (validation_failed throws); fall through to the event lookup.
    }

    const event = readLatestDistillEvent(`${sandbox.dataDir}/state.db`, probe.assetRef);
    if (!event) {
      // No event recorded — improve didn't pick the ref up, or the feature
      // gate suppressed the event. Treat as `skipped` so the case still
      // produces a measurable outcome.
      return { outcome: "skipped", errors };
    }
    const outcome = (event.metadata?.outcome as DistillProbeOutcome | undefined) ?? "skipped";
    const score = typeof event.metadata?.score === "number" ? (event.metadata.score as number) : undefined;
    const reason = typeof event.metadata?.reason === "string" ? (event.metadata.reason as string) : undefined;
    return { outcome, score, reason, errors };
  } finally {
    if (!ctx.keepSandbox) sandbox.cleanup();
  }
}

export async function runJudgeCalibrationCase(c: EvalCase, ctx: EvalContext): Promise<EvalCaseResult> {
  const start = Date.now();
  const probesDirRel = String(c.input.probesDir ?? "probes");
  const samplesPerProbe = Math.max(1, Number(c.input.samplesPerProbe ?? 3));
  const improveArgs = Array.isArray(c.input.improveArgs) ? (c.input.improveArgs as string[]) : [];
  const expected = c.expected as { minAgreement?: number; maxVariance?: number };
  const minAgreement = typeof expected.minAgreement === "number" ? expected.minAgreement : 0.5;
  const maxVariance = typeof expected.maxVariance === "number" ? expected.maxVariance : 0.5;

  const suiteDir = path.join(ctx.casesRoot, c.suite);
  const probesDirAbs = path.isAbsolute(probesDirRel)
    ? probesDirRel
    : path.join(suiteDir, probesDirRel);

  const sandboxConfig = resolveJudgeCalibrationSandboxConfig(ctx.env);
  if (!sandboxConfig.ok || !sandboxConfig.config) {
    return {
      caseId: c.id,
      type: "judge-calibration",
      score: 1,
      passed: true,
      skipped: true,
      skipReason: sandboxConfig.reason ?? "judge-calibration precondition not met",
      metrics: {},
      evidence: {
        precondition: sandboxConfig.reason,
      },
      durationMs: Date.now() - start,
    };
  }

  let probes: ProbeFile[];
  try {
    probes = loadProbes(probesDirAbs);
  } catch (err) {
    return errorResult(c, err instanceof Error ? err.message : String(err), start);
  }
  if (probes.length === 0) {
    return errorResult(c, `no probes found under ${probesDirAbs}`, start);
  }

  // Run each probe `samplesPerProbe` times in independent sandboxes.
  const perProbe: PerProbeMetric[] = [];
  for (const probe of probes) {
    const sampleErrors: string[] = [];
    const actual: DistillProbeOutcome[] = [];
    const scoreSamples: number[] = [];
    for (let i = 0; i < samplesPerProbe; i++) {
      try {
        const { outcome, score, errors } = await runProbeOnce(probe, ctx, improveArgs, sandboxConfig.config);
        actual.push(outcome);
        if (typeof score === "number" && Number.isFinite(score)) scoreSamples.push(score);
        if (errors.length > 0) sampleErrors.push(...errors.map((e) => `[${probe.id}#${i}] ${e}`));
      } catch (err) {
        sampleErrors.push(`[${probe.id}#${i}] uncaught: ${err instanceof Error ? err.message : String(err)}`);
        actual.push("skipped");
      }
    }
    const expectedOutcome = probe.humanGrade.expectedOutcome;
    const agreementCount = actual.filter((a) => a === expectedOutcome).length;
    const variance = disagreementVariance(actual);
    const band = probe.humanGrade.expectedScoreBand;
    const scoreBandMatch =
      band && scoreSamples.length > 0
        ? scoreSamples.filter((s) => s >= band[0] && s <= band[1]).length / scoreSamples.length
        : 0;
    perProbe.push({
      probeId: probe.id,
      assetRef: probe.assetRef,
      expected: expectedOutcome,
      actual,
      agreementCount,
      variance,
      scoreSamples,
      scoreBandMatch,
      errors: sampleErrors,
    });
  }

  // Aggregate.
  const totalSamples = perProbe.reduce((a, p) => a + p.actual.length, 0);
  const totalAgreed = perProbe.reduce((a, p) => a + p.agreementCount, 0);
  const agreementRate = totalSamples === 0 ? 0 : totalAgreed / totalSamples;

  const perBand: Record<HumanGradedOutcome, { probes: number; agreedSamples: number; rate: number }> = {
    queued: { probes: 0, agreedSamples: 0, rate: 0 },
    review_needed: { probes: 0, agreedSamples: 0, rate: 0 },
    quality_rejected: { probes: 0, agreedSamples: 0, rate: 0 },
    validation_failed: { probes: 0, agreedSamples: 0, rate: 0 },
  };
  for (const p of perProbe) {
    const b = perBand[p.expected];
    b.probes += 1;
    b.agreedSamples += p.agreementCount;
  }
  for (const key of Object.keys(perBand) as HumanGradedOutcome[]) {
    const b = perBand[key];
    const denom = b.probes * samplesPerProbe;
    b.rate = denom === 0 ? 0 : b.agreedSamples / denom;
  }

  const variances = perProbe.map((p) => p.variance);
  const medianVariance = median(variances);
  const meanVariance = mean(variances);
  const flipRate =
    perProbe.length === 0 ? 0 : perProbe.filter((p) => p.variance > 0).length / perProbe.length;

  // Scoring: linear blend of agreement (0.6) and inverse-variance (0.4).
  // Linear partial credit when below the floor — never negative.
  const agreementScore = Math.min(1, Math.max(0, agreementRate / Math.max(1e-9, minAgreement)));
  const varianceScore =
    medianVariance <= maxVariance
      ? 1
      : Math.max(0, 1 - (medianVariance - maxVariance) / Math.max(1e-9, 1 - maxVariance));
  const blended = 0.6 * agreementScore + 0.4 * varianceScore;
  const score = Math.min(1, Math.max(0, blended));
  const passThreshold = c.scoring?.passThreshold ?? 0.8;

  const metrics: JudgeCalibrationMetrics = {
    totalProbes: perProbe.length,
    samplesPerProbe,
    agreementRate,
    perBand,
    medianVariance,
    meanVariance,
    flipRate,
    perProbe: perProbe.map((p) => ({
      probeId: p.probeId,
      expected: p.expected,
      actual: p.actual,
      agreementCount: p.agreementCount,
      variance: p.variance,
    })),
  };

  const errs = perProbe.flatMap((p) => p.errors);
  return {
    caseId: c.id,
    type: "judge-calibration",
    score,
    passed: score >= passThreshold && agreementRate >= minAgreement && medianVariance <= maxVariance,
    metrics: {
      // The full structured payload — orchestrator hoists this into
      // envelope.metrics.judgeCalibration in run.ts.
      judgeCalibration: metrics,
      probesDir: probesDirAbs,
      minAgreement,
      maxVariance,
      agreementScore,
      varianceScore,
    },
    evidence: {
      probesDir: probesDirAbs,
      perProbe: perProbe.map((p) => ({
        probeId: p.probeId,
        assetRef: p.assetRef,
        expected: p.expected,
        actual: p.actual,
        scoreSamples: p.scoreSamples,
        scoreBandMatch: p.scoreBandMatch,
      })),
      sampleErrorCount: errs.length,
      sampleErrors: errs.slice(0, 20),
    },
    errors: errs.length > 0 ? errs.slice(0, 10) : undefined,
    durationMs: Date.now() - start,
  };
}

function errorResult(c: EvalCase, message: string, start: number): EvalCaseResult {
  return {
    caseId: c.id,
    type: "judge-calibration",
    score: 0,
    passed: false,
    metrics: {},
    evidence: {},
    errors: [message],
    durationMs: Date.now() - start,
  };
}
