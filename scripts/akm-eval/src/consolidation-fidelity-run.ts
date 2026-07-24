#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEmbeddedJsonResponse } from "../../../src/core/parse";
import promptTemplate from "./consolidation-fidelity-prompt.md" with { type: "text" };
import {
  CONSOLIDATION_FIDELITY_MANIFEST_PATH,
  CONSOLIDATION_ORACLE_LIMITS,
  type ConsolidationFidelityClass,
  type ConsolidationFidelityFixture,
  type ConsolidationFidelityManifest,
  type ConsolidationOracleResult,
  type GeneratedConsolidationCandidate,
  gradeGeneratedConsolidationCandidate,
  loadConsolidationFidelityManifest,
  normalizeDirectProvenance,
} from "./consolidation-fidelity";

export const CONSOLIDATION_FIDELITY_MODEL = "qwen/qwen3.5-9b";
export const CONSOLIDATION_FIDELITY_TEMPERATURE = 0;
export const CONSOLIDATION_FIDELITY_TIMEOUT_MS = 600_000;

interface CompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ConsolidationFidelityCompletion {
  rawContent: string;
  observedModel?: string;
  finishReason?: string;
  usage: CompletionUsage;
  durationMs: number;
}

export type ConsolidationFidelityComplete = (
  prompt: string,
  fixture: ConsolidationFidelityFixture,
) => Promise<ConsolidationFidelityCompletion>;

export interface ConsolidationFidelityCaseResult {
  fixtureId: string;
  class: ConsolidationFidelityClass;
  fixtureCalibrationLabel: "lossy" | "safe";
  validModelEvidence: boolean;
  candidateParsed: boolean;
  candidate?: GeneratedConsolidationCandidate;
  oracle?: ConsolidationOracleResult;
  response: {
    requestedModel: string;
    observedModel?: string;
    finishReason?: string;
    promptSha256: string;
    rawContent?: string;
    usage: CompletionUsage;
    durationMs: number;
  };
  failure?: string;
}

export interface ConsolidationFidelityMetrics {
  caseCount: number;
  validModelEvidenceCaseCount: number;
  candidateParseRate: number;
  oraclePassRate: number;
  semanticScore: number;
  requiredClaimRetention: number;
  forbiddenClaimAvoidance: number;
  provenanceScore: number;
  directProvenanceRetention: number;
  negationScore: number;
  usageReportedCaseCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byClass: Record<string, { cases: number; passed: number; passRate: number }>;
}

export interface ConsolidationFidelityMeasurement {
  schemaVersion: 1;
  suite: "consolidation-fidelity";
  status: "conclusive" | "inconclusive";
  statusReasons: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  generation: {
    endpoint: string;
    requestedModel: typeof CONSOLIDATION_FIDELITY_MODEL;
    temperature: typeof CONSOLIDATION_FIDELITY_TEMPERATURE;
    enableThinking: false;
    concurrency: 1;
    timeoutMs: number;
    observedModels: string[];
  };
  inputs: {
    manifestPath: string;
    manifestSha256: string;
    caseCount: number;
  };
  metrics: ConsolidationFidelityMetrics;
  artifacts: {
    result: "eval-result.json";
    cases: "case-results.jsonl";
  };
  caseResults: ConsolidationFidelityCaseResult[];
}

interface MeasurementOptions {
  endpoint: string;
  manifest?: ConsolidationFidelityManifest;
  manifestPath?: string;
  manifestSha256?: string;
  complete: ConsolidationFidelityComplete;
  onCaseComplete?: (result: ConsolidationFidelityCaseResult, index: number, total: number) => void;
}

interface OpenAiClientOptions {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface OpenAiResponse {
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("endpoint must not contain credentials");
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/chat/completions")) {
    url.pathname = pathname;
  } else if (pathname.endsWith("/v1")) {
    url.pathname = `${pathname}/chat/completions`;
  } else {
    url.pathname = `${pathname}/v1/chat/completions`.replace(/^\/\//, "/");
  }
  return url.toString();
}

export function renderConsolidationFidelityPrompt(fixture: ConsolidationFidelityFixture): string {
  return promptTemplate.replace("{{SOURCES_JSON}}", JSON.stringify(fixture.sources, null, 2));
}

function parseGeneratedCandidate(raw: string): GeneratedConsolidationCandidate | undefined {
  const parsed = parseEmbeddedJsonResponse<unknown>(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.body !== "string" || candidate.body.trim() === "") return undefined;
  if (candidate.body.length > CONSOLIDATION_ORACLE_LIMITS.bodyChars) return undefined;
  if (!Array.isArray(candidate.directProvenance)) return undefined;
  if (candidate.directProvenance.length > CONSOLIDATION_ORACLE_LIMITS.provenanceRefs) return undefined;
  if (!candidate.directProvenance.every((ref) => typeof ref === "string")) return undefined;
  return { body: candidate.body, directProvenance: candidate.directProvenance as string[] };
}

export function createConsolidationFidelityClient(options: OpenAiClientOptions): ConsolidationFidelityComplete {
  const endpoint = normalizeEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? CONSOLIDATION_FIDELITY_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? fetch;

  return async (prompt) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: CONSOLIDATION_FIDELITY_MODEL,
          temperature: CONSOLIDATION_FIDELITY_TEMPERATURE,
          enable_thinking: false,
          messages: [
            {
              role: "system",
              content: "Return only the requested consolidation candidate JSON. Do not add commentary.",
            },
            { role: "user", content: prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "consolidation_fidelity_candidate",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  body: { type: "string" },
                  directProvenance: { type: "array", items: { type: "string" } },
                },
                required: ["body", "directProvenance"],
              },
            },
          },
        }),
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 300)}`);

      let parsed: OpenAiResponse;
      try {
        parsed = JSON.parse(responseText) as OpenAiResponse;
      } catch {
        throw new Error("endpoint returned non-JSON chat completion response");
      }
      const choice = parsed.choices?.[0];
      const usage = parsed.usage;
      return {
        rawContent: typeof choice?.message?.content === "string" ? choice.message.content : "",
        observedModel: typeof parsed.model === "string" ? parsed.model : undefined,
        finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
        usage: {
          promptTokens: finiteNonNegative(usage?.prompt_tokens),
          completionTokens: finiteNonNegative(usage?.completion_tokens),
          totalTokens: finiteNonNegative(usage?.total_tokens),
        },
        durationMs: performance.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

function buildMetrics(
  manifest: ConsolidationFidelityManifest,
  results: ConsolidationFidelityCaseResult[],
): ConsolidationFidelityMetrics {
  let requiredClaims = 0;
  let retainedRequiredClaims = 0;
  let forbiddenClaims = 0;
  let absentForbiddenClaims = 0;
  let expectedProvenance = 0;
  let retainedProvenance = 0;
  let exactProvenanceCases = 0;
  let passedCases = 0;
  let parsedCandidates = 0;
  let negationCases = 0;
  let passedNegationCases = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let usageReportedCaseCount = 0;
  const byClass: ConsolidationFidelityMetrics["byClass"] = {};

  for (const [index, fixture] of manifest.cases.entries()) {
    const result = results[index];
    if (!result) throw new Error(`missing measurement result for fixture ${fixture.id}`);
    requiredClaims += fixture.requiredClaims.length;
    forbiddenClaims += fixture.forbiddenClaims.length;
    expectedProvenance += new Set(
      fixture.sources.flatMap((source) => {
        const normalized = normalizeDirectProvenance(source.ref);
        return normalized ? [normalized] : [];
      }),
    ).size;
    if (result.candidateParsed) parsedCandidates++;
    if (result.oracle) {
      retainedRequiredClaims += result.oracle.requiredClaims.retained.length;
      absentForbiddenClaims += result.oracle.forbiddenClaims.absent.length;
      retainedProvenance += result.oracle.directProvenance.retained.length;
      if (result.oracle.directProvenance.passed) exactProvenanceCases++;
      if (result.oracle.oraclePassed) passedCases++;
    }
    if (fixture.class === "negation-adversarial") {
      negationCases++;
      if (result.oracle?.requiredClaims.passed && result.oracle.forbiddenClaims.passed) passedNegationCases++;
    }
    const classMetric = byClass[fixture.class] ?? { cases: 0, passed: 0, passRate: 0 };
    classMetric.cases++;
    if (result.oracle?.oraclePassed) classMetric.passed++;
    byClass[fixture.class] = classMetric;

    const usage = result.response.usage;
    if (usage.promptTokens !== undefined && usage.completionTokens !== undefined && usage.totalTokens !== undefined) {
      usageReportedCaseCount++;
    }
    promptTokens += usage.promptTokens ?? 0;
    completionTokens += usage.completionTokens ?? 0;
    totalTokens += usage.totalTokens ?? 0;
  }

  for (const metric of Object.values(byClass)) metric.passRate = ratio(metric.passed, metric.cases);
  const totalClaims = requiredClaims + forbiddenClaims;
  return {
    caseCount: manifest.cases.length,
    validModelEvidenceCaseCount: results.filter((result) => result.validModelEvidence).length,
    candidateParseRate: ratio(parsedCandidates, manifest.cases.length),
    oraclePassRate: ratio(passedCases, manifest.cases.length),
    semanticScore: ratio(retainedRequiredClaims + absentForbiddenClaims, totalClaims),
    requiredClaimRetention: ratio(retainedRequiredClaims, requiredClaims),
    forbiddenClaimAvoidance: ratio(absentForbiddenClaims, forbiddenClaims),
    provenanceScore: ratio(exactProvenanceCases, manifest.cases.length),
    directProvenanceRetention: ratio(retainedProvenance, expectedProvenance),
    negationScore: ratio(passedNegationCases, negationCases),
    usageReportedCaseCount,
    promptTokens,
    completionTokens,
    totalTokens,
    byClass,
  };
}

export async function runConsolidationFidelityMeasurement(
  options: MeasurementOptions,
): Promise<ConsolidationFidelityMeasurement> {
  const manifest = options.manifest ?? loadConsolidationFidelityManifest(options.manifestPath);
  const manifestPath = options.manifestPath ?? CONSOLIDATION_FIDELITY_MANIFEST_PATH;
  const manifestSha256 =
    options.manifestSha256 ??
    (fs.existsSync(manifestPath) ? sha256(fs.readFileSync(manifestPath)) : sha256(JSON.stringify(manifest)));
  const endpoint = normalizeEndpoint(options.endpoint);
  const startedAt = new Date();
  const started = performance.now();
  const caseResults: ConsolidationFidelityCaseResult[] = [];

  for (const [index, fixture] of manifest.cases.entries()) {
    const prompt = renderConsolidationFidelityPrompt(fixture);
    let result: ConsolidationFidelityCaseResult;
    try {
      const completion = await options.complete(prompt, fixture);
      const validModelEvidence = completion.observedModel === CONSOLIDATION_FIDELITY_MODEL;
      const candidate = validModelEvidence ? parseGeneratedCandidate(completion.rawContent) : undefined;
      const oracle = candidate ? gradeGeneratedConsolidationCandidate(fixture, candidate) : undefined;
      let failure: string | undefined;
      if (!completion.observedModel) failure = "chat completion did not report an observed model ID";
      else if (!validModelEvidence) {
        failure = `observed model ${completion.observedModel} does not match ${CONSOLIDATION_FIDELITY_MODEL}`;
      } else if (!candidate) failure = "model completion was not a valid consolidation candidate";
      result = {
        fixtureId: fixture.id,
        class: fixture.class,
        fixtureCalibrationLabel: fixture.label,
        validModelEvidence,
        candidateParsed: candidate !== undefined,
        candidate,
        oracle,
        response: {
          requestedModel: CONSOLIDATION_FIDELITY_MODEL,
          observedModel: completion.observedModel,
          finishReason: completion.finishReason,
          promptSha256: sha256(prompt),
          rawContent: completion.rawContent,
          usage: completion.usage,
          durationMs: completion.durationMs,
        },
        failure,
      };
    } catch (error) {
      result = {
        fixtureId: fixture.id,
        class: fixture.class,
        fixtureCalibrationLabel: fixture.label,
        validModelEvidence: false,
        candidateParsed: false,
        response: {
          requestedModel: CONSOLIDATION_FIDELITY_MODEL,
          promptSha256: sha256(prompt),
          usage: {},
          durationMs: 0,
        },
        failure: error instanceof Error ? error.message : String(error),
      };
    }
    caseResults.push(result);
    options.onCaseComplete?.(result, index, manifest.cases.length);
  }

  const statusReasons = caseResults
    .filter((result) => !result.validModelEvidence)
    .map((result) => `${result.fixtureId}: ${result.failure ?? "invalid model evidence"}`);
  const completedAt = new Date();
  return {
    schemaVersion: 1,
    suite: "consolidation-fidelity",
    status: statusReasons.length === 0 ? "conclusive" : "inconclusive",
    statusReasons,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: performance.now() - started,
    generation: {
      endpoint,
      requestedModel: CONSOLIDATION_FIDELITY_MODEL,
      temperature: CONSOLIDATION_FIDELITY_TEMPERATURE,
      enableThinking: false,
      concurrency: 1,
      timeoutMs: CONSOLIDATION_FIDELITY_TIMEOUT_MS,
      observedModels: [
        ...new Set(
          caseResults.flatMap((result) =>
            result.response.observedModel ? [result.response.observedModel] : [],
          ),
        ),
      ].sort(),
    },
    inputs: { manifestPath, manifestSha256, caseCount: manifest.cases.length },
    metrics: buildMetrics(manifest, caseResults),
    artifacts: { result: "eval-result.json", cases: "case-results.jsonl" },
    caseResults,
  };
}

export function writeConsolidationFidelityArtifacts(
  outDir: string,
  measurement: ConsolidationFidelityMeasurement,
): void {
  if (fs.existsSync(outDir)) throw new Error(`output path already exists: ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });
  const { caseResults, ...summary } = measurement;
  fs.writeFileSync(path.join(outDir, "eval-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(
    path.join(outDir, "case-results.jsonl"),
    `${caseResults.map((result) => JSON.stringify(result)).join("\n")}\n`,
  );
}

interface CliOptions {
  endpoint?: string;
  manifest?: string;
  out?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) throw new Error("missing argument");
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--endpoint":
        options.endpoint = next();
        break;
      case "--manifest":
        options.manifest = next();
        break;
      case "--out":
        options.out = next();
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(`akm-eval consolidation fidelity

Usage:
  akm-eval-consolidation-fidelity --endpoint <OpenAI base URL> --out <new directory> [--manifest <json>]

The measurement always requests ${CONSOLIDATION_FIDELITY_MODEL} at temperature 0,
disables thinking, and runs one request at a time. AKM_LLM_API_KEY is optional.
`);
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const endpoint = options.endpoint ?? process.env.AKM_EVAL_CONSOLIDATION_ENDPOINT;
  if (!endpoint) throw new Error("--endpoint or AKM_EVAL_CONSOLIDATION_ENDPOINT is required");
  if (!options.out) throw new Error("--out is required");
  const outDir = path.resolve(options.out);
  if (fs.existsSync(outDir)) throw new Error(`output path already exists: ${outDir}`);
  const manifestPath = options.manifest ? path.resolve(options.manifest) : CONSOLIDATION_FIDELITY_MANIFEST_PATH;

  const measurement = await runConsolidationFidelityMeasurement({
    endpoint,
    manifestPath,
    complete: createConsolidationFidelityClient({ endpoint, apiKey: process.env.AKM_LLM_API_KEY }),
    onCaseComplete: (result, index, total) => {
      const outcome = result.oracle?.oraclePassed ? "pass" : result.validModelEvidence ? "fail" : "inconclusive";
      process.stderr.write(`[consolidation-fidelity] ${index + 1}/${total} ${result.fixtureId}: ${outcome}\n`);
    },
  });
  writeConsolidationFidelityArtifacts(outDir, measurement);
  process.stdout.write(
    `${JSON.stringify({
      status: measurement.status,
      statusReasons: measurement.statusReasons,
      metrics: measurement.metrics,
      out: outDir,
    })}\n`,
  );
  return measurement.status === "conclusive" ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
