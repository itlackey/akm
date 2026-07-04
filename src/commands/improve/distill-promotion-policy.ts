// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseAssetRef } from "../../core/asset/asset-ref";
import { assembleAsset } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";

export interface PromotionFeedbackEvent {
  metadata?: Record<string, unknown>;
}

export interface PromotionPolicyInput {
  inputRef: string;
  assetContent: string | null;
  feedbackEvents: readonly PromotionFeedbackEvent[];
}

export interface MemoryPromotionAssessment {
  applicable: boolean;
  promote: boolean;
  score: number;
  threshold: number;
  knowledgeRef: string;
  content?: string;
  blockedBy: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  modelName?: string;
}

export interface PromotionBenchmarkCase {
  name: string;
  input: PromotionPolicyInput;
  expectPromote: boolean;
  split?: "train" | "heldout";
  promoteValue?: number;
  falsePromoteCost?: number;
  missedPromoteCost?: number;
}

export interface PromotionBenchmarkResult {
  total: number;
  correct: number;
  falsePositives: number;
  falseNegatives: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  trueNegatives: number;
  netOutcomeScore: number;
  capturedPromoteValue: number;
  preventedFalsePromotionCost: number;
  results: Array<{
    name: string;
    expectPromote: boolean;
    assessment: MemoryPromotionAssessment;
    passed: boolean;
  }>;
}

export interface PromotionPolicySelectionResult {
  corpusSize: number;
  trainingSize: number;
  heldOutSize: number;
  selectedModel: { name: string; threshold: number };
  training: PromotionBenchmarkResult;
  heldOut: PromotionBenchmarkResult;
  baselines: Array<{
    name: string;
    heldOut: PromotionBenchmarkResult;
    noWorseThanSelected: boolean;
    strictWin: boolean;
    strictWinMetrics: string[];
  }>;
  strictlyBeatsBaselines: boolean;
}

interface PromotionFeatures {
  positiveFeedback: number;
  negativeFeedback: number;
  hasCuratedQuality: boolean;
  confidenceBoost: number;
  hasSource: boolean;
  hasObservedAt: boolean;
  hasDescription: boolean;
  hasTags: boolean;
  substantiveBody: boolean;
  tentativeLanguage: boolean;
}

interface PromotionModelConfig {
  name: string;
  positiveWeight: number;
  repeatedPositiveWeight: number;
  noPositivePenalty: number;
  singlePositivePenalty: number;
  negativeWeight: number;
  curatedWeight: number;
  confidenceWeight: number;
  sourceWeight: number;
  observedAtWeight: number;
  descriptionWeight: number;
  tagWeight: number;
  substantiveBodyWeight: number;
  tentativePenalty: number;
}

interface PromotionEvaluationPolicy {
  name: string;
  threshold: number;
  assess: (input: PromotionPolicyInput) => MemoryPromotionAssessment;
}

function hasNonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim().length > 0);
}

function hasConflictMarkers(metadata: Record<string, unknown>): boolean {
  return (
    metadata.conflict === true ||
    metadata.conflicted === true ||
    metadata.contradiction === true ||
    metadata.contradicted === true ||
    metadata.superseded === true ||
    metadata.obsolete === true ||
    metadata.retracted === true ||
    hasNonEmptyList(metadata.contradictedBy) ||
    hasNonEmptyList(metadata.supersededBy)
  );
}

function hasTentativeLanguage(text: string): boolean {
  return /\b(maybe|might|probably|possibly|perhaps|unclear|unsure|not sure|tbd|todo|investigate)\b/i.test(text);
}

function scoreConfidence(confidence: unknown): number {
  if (typeof confidence !== "number") return 0;
  if (confidence >= 0.95) return 1;
  if (confidence >= 0.85) return 0.7;
  if (confidence >= 0.75) return 0.35;
  return 0;
}

function deriveDescription(body: string, description: string | undefined): string | undefined {
  if (description && description.length > 0) return description;
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.replace(/^#+\s*/, "")
    ?.slice(0, 160);
}

export function deriveKnowledgeRef(inputRef: string): string {
  const parsed = parseAssetRef(inputRef);
  return `knowledge:${parsed.name}`;
}

function collectPromotionFeatures(input: PromotionPolicyInput): {
  blockedBy: string[];
  features?: PromotionFeatures;
  body?: string;
  description?: string;
  tags?: unknown[];
  observedAt?: string;
  source?: string;
} {
  const parsed = parseAssetRef(input.inputRef);
  const blockedBy: string[] = [];

  if (parsed.type !== "memory") {
    return { blockedBy: ["not-memory"] };
  }

  if (parsed.name.endsWith(".derived")) {
    return { blockedBy: ["derived-memory"] };
  }

  if (!input.assetContent) {
    return { blockedBy: ["missing-asset-content"] };
  }

  const parsedContent = parseFrontmatter(input.assetContent);
  const fm = parsedContent.data;
  const body = parsedContent.content.trim();
  if (!body) {
    return { blockedBy: ["empty-body"] };
  }

  if (hasConflictMarkers(fm)) blockedBy.push("asset-conflict-marker");
  const quality = typeof fm.quality === "string" ? fm.quality.trim().toLowerCase() : undefined;
  if (quality === "proposed") blockedBy.push("proposed-quality");
  if (fm.subjective === true) blockedBy.push("subjective-memory");
  if (typeof fm.expires === "string" && fm.expires.trim()) blockedBy.push("expiring-memory");
  if (input.feedbackEvents.some((event) => event.metadata && hasConflictMarkers(event.metadata))) {
    blockedBy.push("feedback-conflict-marker");
  }

  if (blockedBy.length > 0) {
    return { blockedBy, body };
  }

  let positiveFeedback = 0;
  let negativeFeedback = 0;
  for (const event of input.feedbackEvents) {
    const signal = typeof event.metadata?.signal === "string" ? event.metadata.signal.trim().toLowerCase() : undefined;
    if (signal === "positive") positiveFeedback += 1;
    if (signal === "negative") negativeFeedback += 1;
  }

  const description = typeof fm.description === "string" ? fm.description.trim() : undefined;
  const tags = Array.isArray(fm.tags) ? fm.tags : undefined;
  const source = typeof fm.source === "string" && fm.source.trim() ? fm.source.trim() : undefined;
  const observedAt = typeof fm.observed_at === "string" && fm.observed_at.trim() ? fm.observed_at.trim() : undefined;
  const features: PromotionFeatures = {
    positiveFeedback,
    negativeFeedback,
    hasCuratedQuality: quality === "curated",
    confidenceBoost: scoreConfidence(fm.confidence),
    hasSource: source !== undefined,
    hasObservedAt: observedAt !== undefined,
    hasDescription: description !== undefined,
    hasTags: Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && tag.trim().length > 0),
    substantiveBody: body.split(/\s+/).filter(Boolean).length >= 8,
    tentativeLanguage: hasTentativeLanguage([description, body].filter(Boolean).join("\n")),
  };

  return { blockedBy, features, body, description, tags, observedAt, source };
}

function buildKnowledgeContent(input: PromotionPolicyInput): string {
  const parsedContent = parseFrontmatter(input.assetContent as string);
  const fm = parsedContent.data;
  const body = parsedContent.content.trim();
  const description = typeof fm.description === "string" ? fm.description.trim() : undefined;
  const normalizedDescription = deriveDescription(body, description);
  const sources = [input.inputRef];
  if (typeof fm.source === "string" && fm.source.trim()) sources.push(fm.source.trim());
  const knowledgeFrontmatter: Record<string, unknown> = {
    ...(normalizedDescription ? { description: normalizedDescription } : {}),
    ...(Array.isArray(fm.tags) ? { tags: fm.tags } : {}),
    ...(typeof fm.observed_at === "string" && fm.observed_at.trim() ? { observed_at: fm.observed_at.trim() } : {}),
    sources,
  };
  return assembleAsset(knowledgeFrontmatter, body);
}

function assessWithWeightedModel(
  input: PromotionPolicyInput,
  model: PromotionModelConfig,
  threshold: number,
): MemoryPromotionAssessment {
  const knowledgeRef = deriveKnowledgeRef(input.inputRef);
  const featureState = collectPromotionFeatures(input);
  if (featureState.blockedBy.length > 0) {
    return {
      applicable: !featureState.blockedBy.includes("not-memory"),
      promote: false,
      score: 0,
      threshold,
      knowledgeRef,
      blockedBy: featureState.blockedBy,
      positiveSignals: [],
      negativeSignals: [],
      modelName: model.name,
    };
  }

  const features = featureState.features as PromotionFeatures;
  let score = 0;
  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];

  if (features.positiveFeedback > 0) {
    const boost = Math.min(features.positiveFeedback, 4) * model.positiveWeight;
    score += boost;
    positiveSignals.push(
      `${features.positiveFeedback} positive feedback event${features.positiveFeedback === 1 ? "" : "s"}`,
    );
  } else {
    score -= model.noPositivePenalty;
    negativeSignals.push("no positive feedback reinforcement");
  }

  if (features.positiveFeedback >= 2) {
    score += model.repeatedPositiveWeight;
    positiveSignals.push("repeated reinforcement");
  } else if (features.positiveFeedback === 1) {
    score -= model.singlePositivePenalty;
    negativeSignals.push("only one reinforcing feedback event");
  }

  if (features.negativeFeedback > 0) {
    score -= features.negativeFeedback * model.negativeWeight;
    negativeSignals.push(
      `${features.negativeFeedback} negative feedback event${features.negativeFeedback === 1 ? "" : "s"}`,
    );
  }

  if (features.hasCuratedQuality) {
    score += model.curatedWeight;
    positiveSignals.push("curated quality");
  }
  if (features.confidenceBoost > 0) {
    score += features.confidenceBoost * model.confidenceWeight;
    positiveSignals.push("strong confidence");
  }
  if (features.hasSource) {
    score += model.sourceWeight;
    positiveSignals.push("linked source");
  }
  if (features.hasObservedAt) {
    score += model.observedAtWeight;
    positiveSignals.push("observed_at present");
  }
  if (features.hasDescription) {
    score += model.descriptionWeight;
    positiveSignals.push("description present");
  }
  if (features.hasTags) {
    score += model.tagWeight;
    positiveSignals.push("tagged memory");
  }
  if (features.substantiveBody) {
    score += model.substantiveBodyWeight;
    positiveSignals.push("substantive body");
  }
  if (features.tentativeLanguage) {
    score -= model.tentativePenalty;
    negativeSignals.push("tentative language");
  }

  const promote = score >= threshold;
  return {
    applicable: true,
    promote,
    score,
    threshold,
    knowledgeRef,
    ...(promote ? { content: buildKnowledgeContent(input) } : {}),
    blockedBy: [],
    positiveSignals,
    negativeSignals,
    modelName: model.name,
  };
}

function precision(tp: number, fp: number): number {
  return tp + fp === 0 ? 1 : tp / (tp + fp);
}

function recall(tp: number, fn: number): number {
  return tp + fn === 0 ? 1 : tp / (tp + fn);
}

function f1Score(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function casePromoteValue(testCase: PromotionBenchmarkCase): number {
  return testCase.promoteValue ?? 3;
}

function caseFalsePromoteCost(testCase: PromotionBenchmarkCase): number {
  return testCase.falsePromoteCost ?? 4;
}

function caseMissedPromoteCost(testCase: PromotionBenchmarkCase): number {
  return testCase.missedPromoteCost ?? 2;
}

export function evaluateMemoryPromotionBenchmark(
  cases: readonly PromotionBenchmarkCase[],
  policy: PromotionEvaluationPolicy = DEFAULT_PROMOTION_POLICY,
): PromotionBenchmarkResult {
  const results = cases.map((fixture) => {
    const assessment = policy.assess(fixture.input);
    const passed = assessment.promote === fixture.expectPromote;
    return {
      fixture,
      name: fixture.name,
      expectPromote: fixture.expectPromote,
      assessment,
      passed,
    };
  });

  const truePositives = results.filter((result) => result.assessment.promote && result.expectPromote).length;
  const trueNegatives = results.filter((result) => !result.assessment.promote && !result.expectPromote).length;
  const falsePositives = results.filter((result) => result.assessment.promote && !result.expectPromote).length;
  const falseNegatives = results.filter((result) => !result.assessment.promote && result.expectPromote).length;
  const correct = truePositives + trueNegatives;
  const p = precision(truePositives, falsePositives);
  const r = recall(truePositives, falseNegatives);
  let netOutcomeScore = 0;
  let capturedPromoteValue = 0;
  let preventedFalsePromotionCost = 0;
  for (const result of results) {
    if (result.expectPromote && result.assessment.promote) {
      const value = casePromoteValue(result.fixture);
      netOutcomeScore += value;
      capturedPromoteValue += value;
    } else if (result.expectPromote && !result.assessment.promote) {
      netOutcomeScore -= caseMissedPromoteCost(result.fixture);
    } else if (!result.expectPromote && result.assessment.promote) {
      netOutcomeScore -= caseFalsePromoteCost(result.fixture);
    } else {
      preventedFalsePromotionCost += caseFalsePromoteCost(result.fixture);
    }
  }

  return {
    total: results.length,
    correct,
    falsePositives,
    falseNegatives,
    accuracy: results.length === 0 ? 1 : correct / results.length,
    precision: p,
    recall: r,
    f1: f1Score(p, r),
    truePositives,
    trueNegatives,
    netOutcomeScore,
    capturedPromoteValue,
    preventedFalsePromotionCost,
    results: results.map(({ name, expectPromote, assessment, passed }) => ({
      name,
      expectPromote,
      assessment,
      passed,
    })),
  };
}

const CANDIDATE_MODELS: PromotionModelConfig[] = [
  {
    name: "balanced-evidence",
    positiveWeight: 0.8,
    repeatedPositiveWeight: 0.65,
    noPositivePenalty: 0.9,
    singlePositivePenalty: 0.7,
    negativeWeight: 2.0,
    curatedWeight: 0.55,
    confidenceWeight: 0.7,
    sourceWeight: 0.4,
    observedAtWeight: 0.4,
    descriptionWeight: 0.2,
    tagWeight: 0.15,
    substantiveBodyWeight: 0.15,
    tentativePenalty: 1.1,
  },
  {
    name: "strict-feedback",
    positiveWeight: 0.75,
    repeatedPositiveWeight: 0.8,
    noPositivePenalty: 1.1,
    singlePositivePenalty: 0.9,
    negativeWeight: 2.25,
    curatedWeight: 0.45,
    confidenceWeight: 0.55,
    sourceWeight: 0.35,
    observedAtWeight: 0.35,
    descriptionWeight: 0.15,
    tagWeight: 0.1,
    substantiveBodyWeight: 0.1,
    tentativePenalty: 1.15,
  },
  {
    name: "metadata-friendly",
    positiveWeight: 0.7,
    repeatedPositiveWeight: 0.55,
    noPositivePenalty: 0.75,
    singlePositivePenalty: 0.55,
    negativeWeight: 1.85,
    curatedWeight: 0.75,
    confidenceWeight: 0.9,
    sourceWeight: 0.5,
    observedAtWeight: 0.5,
    descriptionWeight: 0.25,
    tagWeight: 0.2,
    substantiveBodyWeight: 0.2,
    tentativePenalty: 1.0,
  },
];

function thresholdCandidates(): number[] {
  const values: number[] = [];
  for (let value = 2.4; value <= 4.2; value += 0.2) {
    values.push(Number(value.toFixed(1)));
  }
  return values;
}

const POSITIVE_FEEDBACK_BASELINE: PromotionEvaluationPolicy = {
  name: "baseline-positive-feedback",
  threshold: 2,
  assess(input) {
    const knowledgeRef = deriveKnowledgeRef(input.inputRef);
    const featureState = collectPromotionFeatures(input);
    if (featureState.blockedBy.length > 0) {
      return {
        applicable: !featureState.blockedBy.includes("not-memory"),
        promote: false,
        score: 0,
        threshold: 2,
        knowledgeRef,
        blockedBy: featureState.blockedBy,
        positiveSignals: [],
        negativeSignals: [],
        modelName: "baseline-positive-feedback",
      };
    }
    const features = featureState.features as PromotionFeatures;
    const promote = features.positiveFeedback >= 2;
    return {
      applicable: true,
      promote,
      score: features.positiveFeedback,
      threshold: 2,
      knowledgeRef,
      ...(promote ? { content: buildKnowledgeContent(input) } : {}),
      blockedBy: [],
      positiveSignals: promote ? ["baseline positive feedback rule"] : [],
      negativeSignals: promote ? [] : ["baseline positive feedback rule not met"],
      modelName: "baseline-positive-feedback",
    };
  },
};

const METADATA_BASELINE: PromotionEvaluationPolicy = {
  name: "baseline-metadata",
  threshold: 2,
  assess(input) {
    const knowledgeRef = deriveKnowledgeRef(input.inputRef);
    const featureState = collectPromotionFeatures(input);
    if (featureState.blockedBy.length > 0) {
      return {
        applicable: !featureState.blockedBy.includes("not-memory"),
        promote: false,
        score: 0,
        threshold: 2,
        knowledgeRef,
        blockedBy: featureState.blockedBy,
        positiveSignals: [],
        negativeSignals: [],
        modelName: "baseline-metadata",
      };
    }
    const features = featureState.features as PromotionFeatures;
    const metadataScore = (features.hasSource ? 1 : 0) + (features.hasObservedAt ? 1 : 0);
    const promote = metadataScore >= 2;
    return {
      applicable: true,
      promote,
      score: metadataScore,
      threshold: 3,
      knowledgeRef,
      ...(promote ? { content: buildKnowledgeContent(input) } : {}),
      blockedBy: [],
      positiveSignals: promote ? ["baseline metadata rule"] : [],
      negativeSignals: promote ? [] : ["baseline metadata rule not met"],
      modelName: "baseline-metadata",
    };
  },
};

export function selectPromotionPolicy(corpus: readonly PromotionBenchmarkCase[]): PromotionPolicySelectionResult {
  const trainingCases = corpus.filter((testCase) => (testCase.split ?? "train") === "train");
  const heldOutCases = corpus.filter((testCase) => (testCase.split ?? "train") === "heldout");
  let bestPolicy: PromotionEvaluationPolicy | undefined;
  let bestTraining: PromotionBenchmarkResult | undefined;

  for (const model of CANDIDATE_MODELS) {
    for (const threshold of thresholdCandidates()) {
      const policy: PromotionEvaluationPolicy = {
        name: model.name,
        threshold,
        assess: (input) => assessWithWeightedModel(input, model, threshold),
      };
      const training = evaluateMemoryPromotionBenchmark(trainingCases, policy);
      if (!bestTraining) {
        bestTraining = training;
        bestPolicy = policy;
        continue;
      }

      const trainingWins =
        training.f1 > bestTraining.f1 ||
        (training.f1 === bestTraining.f1 && training.netOutcomeScore > bestTraining.netOutcomeScore) ||
        (training.f1 === bestTraining.f1 &&
          training.netOutcomeScore === bestTraining.netOutcomeScore &&
          training.accuracy > bestTraining.accuracy);

      if (trainingWins) {
        bestTraining = training;
        bestPolicy = policy;
      }
    }
  }

  const selectedPolicy = bestPolicy as PromotionEvaluationPolicy;
  const selectedTraining = bestTraining as PromotionBenchmarkResult;
  const heldOut = evaluateMemoryPromotionBenchmark(heldOutCases, selectedPolicy);
  const baselines = [POSITIVE_FEEDBACK_BASELINE, METADATA_BASELINE].map((policy) => {
    const baselineHeldOut = evaluateMemoryPromotionBenchmark(heldOutCases, policy);
    const noWorseThanSelected =
      heldOut.f1 >= baselineHeldOut.f1 && heldOut.netOutcomeScore >= baselineHeldOut.netOutcomeScore;
    const strictWinMetrics: string[] = [];
    if (heldOut.f1 > baselineHeldOut.f1) strictWinMetrics.push("f1");
    if (heldOut.netOutcomeScore > baselineHeldOut.netOutcomeScore) strictWinMetrics.push("netOutcomeScore");
    if (heldOut.accuracy > baselineHeldOut.accuracy) strictWinMetrics.push("accuracy");
    return {
      name: policy.name,
      heldOut: baselineHeldOut,
      noWorseThanSelected,
      strictWin: noWorseThanSelected && strictWinMetrics.length > 0,
      strictWinMetrics,
    };
  });
  const strictlyBeatsBaselines = baselines.every((baseline) => baseline.strictWin);

  return {
    corpusSize: corpus.length,
    trainingSize: trainingCases.length,
    heldOutSize: heldOutCases.length,
    selectedModel: { name: selectedPolicy.name, threshold: selectedPolicy.threshold },
    training: selectedTraining,
    heldOut,
    baselines,
    strictlyBeatsBaselines,
  };
}

// Frozen module-load selection. The promotion policy's selected model was
// historically computed by running `selectPromotionPolicy` over a large
// hardcoded benchmark corpus at import time (a full grid search on every module
// load). That corpus and the grid search now live in the bench test
// (tests/commands/distill/distill-promotion-policy.bench.test.ts), which
// re-runs `selectPromotionPolicy(DEFAULT_PROMOTION_POLICY_CORPUS)` and asserts
// deep equality with this constant so the freeze stays honest.
export const DEFAULT_PROMOTION_POLICY_SELECTION: PromotionPolicySelectionResult = {
  corpusSize: 21,
  trainingSize: 14,
  heldOutSize: 7,
  selectedModel: {
    name: "balanced-evidence",
    threshold: 3.8,
  },
  training: {
    total: 14,
    correct: 13,
    falsePositives: 1,
    falseNegatives: 0,
    accuracy: 0.9285714285714286,
    precision: 0.8333333333333334,
    recall: 1,
    f1: 0.9090909090909091,
    truePositives: 5,
    trueNegatives: 8,
    netOutcomeScore: 11,
    capturedPromoteValue: 15,
    preventedFalsePromotionCost: 33,
    results: [
      {
        name: "deploy-vpn-required",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 4.250000000000001,
          threshold: 3.8,
          knowledgeRef: "knowledge:deploy-vpn-required",
          content:
            "---\ndescription: VPN required before deploy\ntags:\n  - deploy\n  - ops\nobserved_at: 2026-04-20\nsources:\n  - memory:deploy-vpn-required\n  - skill:deploy\n---\n\nAlways connect the VPN before starting production deploys.\n",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "tagged memory",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "release-smoke-test",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 5.240000000000002,
          threshold: 3.8,
          knowledgeRef: "knowledge:release-smoke-test",
          content:
            "---\ndescription: Smoke test gates release\nobserved_at: 2026-04-18\nsources:\n  - memory:release-smoke-test\n  - skill:release\n---\n\nRun the smoke test before tagging a release candidate.\n",
          blockedBy: [],
          positiveSignals: [
            "3 positive feedback events",
            "repeated reinforcement",
            "curated quality",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "kubernetes-rollout-check",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 4.250000000000001,
          threshold: 3.8,
          knowledgeRef: "knowledge:kubernetes-rollout-check",
          content:
            "---\ndescription: Verify rollout status after apply\ntags:\n  - k8s\nobserved_at: 2026-04-15\nsources:\n  - memory:kubernetes-rollout-check\n  - skill:k8s\n---\n\nCheck rollout status after kubectl apply before declaring success.\n",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "tagged memory",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "incident-channel-rule",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 5.450000000000002,
          threshold: 3.8,
          knowledgeRef: "knowledge:incident-channel-rule",
          content:
            "---\ndescription: Incident bridge stays single-threaded\nobserved_at: 2026-04-12\nsources:\n  - memory:incident-channel-rule\n  - skill:incident\n---\n\nKeep one operator narrating decisions in the incident bridge to avoid conflicting instructions.\n",
          blockedBy: [],
          positiveSignals: [
            "3 positive feedback events",
            "repeated reinforcement",
            "curated quality",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "weak-single-signal",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 2.1,
          threshold: 3.8,
          knowledgeRef: "knowledge:weak-single-signal",
          blockedBy: [],
          positiveSignals: [
            "1 positive feedback event",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "tagged memory",
            "substantive body",
          ],
          negativeSignals: ["only one reinforcing feedback event"],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "contested-fact",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 2.65,
          threshold: 3.8,
          knowledgeRef: "knowledge:contested-fact",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "curated quality",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "substantive body",
          ],
          negativeSignals: ["1 negative feedback event"],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "tentative-fact",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 3.0000000000000004,
          threshold: 3.8,
          knowledgeRef: "knowledge:tentative-fact",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "substantive body",
          ],
          negativeSignals: ["tentative language"],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "subjective-preference",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 0,
          threshold: 3.8,
          knowledgeRef: "knowledge:subjective-preference",
          blockedBy: ["subjective-memory"],
          positiveSignals: [],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "feedback-conflict",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: true,
          score: 4.1000000000000005,
          threshold: 3.8,
          knowledgeRef: "knowledge:feedback-conflict",
          content:
            "---\ndescription: VPN required before deploy\nobserved_at: 2026-04-20\nsources:\n  - memory:feedback-conflict\n  - skill:deploy\n---\n\nAlways connect the VPN before starting production deploys.\n",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: false,
      },
      {
        name: "derived-memory",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 3.7,
          threshold: 3.8,
          knowledgeRef: "knowledge:derived-memory",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "description present",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "staging-cutover-order",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 4.840000000000001,
          threshold: 3.8,
          knowledgeRef: "knowledge:staging-cutover-order",
          content:
            "---\ndescription: Cut over staging after migrations\ntags:\n  - db\n  - deploy\nobserved_at: 2026-04-10\nsources:\n  - memory:staging-cutover-order\n  - skill:database\n---\n\nRun database migrations before shifting staging traffic onto the new release.\n",
          blockedBy: [],
          positiveSignals: [
            "3 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "tagged memory",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "temporary-token-workaround",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 0,
          threshold: 3.8,
          knowledgeRef: "knowledge:temporary-token-workaround",
          blockedBy: ["expiring-memory"],
          positiveSignals: [],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "thin-metadata-memory",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 3,
          threshold: 3.8,
          knowledgeRef: "knowledge:thin-metadata-memory",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "linked source",
            "description present",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "promoted-quality-memory",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 0,
          threshold: 3.8,
          knowledgeRef: "knowledge:promoted-quality-memory",
          blockedBy: ["proposed-quality"],
          positiveSignals: [],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
    ],
  },
  heldOut: {
    total: 7,
    correct: 7,
    falsePositives: 0,
    falseNegatives: 0,
    accuracy: 1,
    precision: 1,
    recall: 1,
    f1: 1,
    truePositives: 4,
    trueNegatives: 3,
    netOutcomeScore: 14,
    capturedPromoteValue: 14,
    preventedFalsePromotionCost: 14,
    results: [
      {
        name: "kafka-rebalance-note",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 5.600000000000002,
          threshold: 3.8,
          knowledgeRef: "knowledge:kafka-rebalance-note",
          content:
            "---\ndescription: Pause consumers during rebalance\ntags:\n  - kafka\n  - ops\nobserved_at: 2026-04-08\nsources:\n  - memory:kafka-rebalance-note\n  - skill:kafka\n---\n\nPause consumers during partition rebalances to avoid duplicate processing while assignments settle.\n",
          blockedBy: [],
          positiveSignals: [
            "3 positive feedback events",
            "repeated reinforcement",
            "curated quality",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "tagged memory",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "gha-token-scope",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 4.04,
          threshold: 3.8,
          knowledgeRef: "knowledge:gha-token-scope",
          content:
            "---\ndescription: Minimize GitHub token scopes\ntags:\n  - gha\n  - security\nobserved_at: 2026-04-07\nsources:\n  - memory:gha-token-scope\n  - skill:github-actions\n---\n\nUse the narrowest GitHub token scope that still allows the workflow step to succeed.\n",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "tagged memory",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "helm-debug-guess",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 2.7899999999999996,
          threshold: 3.8,
          knowledgeRef: "knowledge:helm-debug-guess",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "substantive body",
          ],
          negativeSignals: ["tentative language"],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "terraform-state-location",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 5.600000000000002,
          threshold: 3.8,
          knowledgeRef: "knowledge:terraform-state-location",
          content:
            "---\ndescription: Use remote state locks\ntags:\n  - terraform\nobserved_at: 2026-04-04\nsources:\n  - memory:terraform-state-location\n  - skill:terraform\n---\n\nUse remote state with locking enabled before applying shared Terraform stacks.\n",
          blockedBy: [],
          positiveSignals: [
            "3 positive feedback events",
            "repeated reinforcement",
            "curated quality",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "tagged memory",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "mixed-signal-rollback",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 2.65,
          threshold: 3.8,
          knowledgeRef: "knowledge:mixed-signal-rollback",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "curated quality",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "substantive body",
          ],
          negativeSignals: ["1 negative feedback event"],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "cache-ttl-fact",
        expectPromote: true,
        assessment: {
          applicable: true,
          promote: true,
          score: 4.250000000000001,
          threshold: 3.8,
          knowledgeRef: "knowledge:cache-ttl-fact",
          content:
            "---\ndescription: Cache TTL defaults to five minutes\ntags:\n  - cache\n  - platform\nobserved_at: 2026-04-02\nsources:\n  - memory:cache-ttl-fact\n  - skill:platform\n---\n\nThe shared platform cache TTL defaults to five minutes unless the service opts out.\n",
          blockedBy: [],
          positiveSignals: [
            "2 positive feedback events",
            "repeated reinforcement",
            "strong confidence",
            "linked source",
            "observed_at present",
            "description present",
            "tagged memory",
            "substantive body",
          ],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
      {
        name: "personal-shell-alias",
        expectPromote: false,
        assessment: {
          applicable: true,
          promote: false,
          score: 0,
          threshold: 3.8,
          knowledgeRef: "knowledge:personal-shell-alias",
          blockedBy: ["subjective-memory"],
          positiveSignals: [],
          negativeSignals: [],
          modelName: "balanced-evidence",
        },
        passed: true,
      },
    ],
  },
  baselines: [
    {
      name: "baseline-positive-feedback",
      heldOut: {
        total: 7,
        correct: 5,
        falsePositives: 2,
        falseNegatives: 0,
        accuracy: 0.7142857142857143,
        precision: 0.6666666666666666,
        recall: 1,
        f1: 0.8,
        truePositives: 4,
        trueNegatives: 1,
        netOutcomeScore: 4,
        capturedPromoteValue: 14,
        preventedFalsePromotionCost: 4,
        results: [
          {
            name: "kafka-rebalance-note",
            expectPromote: true,
            assessment: {
              applicable: true,
              promote: true,
              score: 3,
              threshold: 2,
              knowledgeRef: "knowledge:kafka-rebalance-note",
              content:
                "---\ndescription: Pause consumers during rebalance\ntags:\n  - kafka\n  - ops\nobserved_at: 2026-04-08\nsources:\n  - memory:kafka-rebalance-note\n  - skill:kafka\n---\n\nPause consumers during partition rebalances to avoid duplicate processing while assignments settle.\n",
              blockedBy: [],
              positiveSignals: ["baseline positive feedback rule"],
              negativeSignals: [],
              modelName: "baseline-positive-feedback",
            },
            passed: true,
          },
          {
            name: "gha-token-scope",
            expectPromote: true,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 2,
              knowledgeRef: "knowledge:gha-token-scope",
              content:
                "---\ndescription: Minimize GitHub token scopes\ntags:\n  - gha\n  - security\nobserved_at: 2026-04-07\nsources:\n  - memory:gha-token-scope\n  - skill:github-actions\n---\n\nUse the narrowest GitHub token scope that still allows the workflow step to succeed.\n",
              blockedBy: [],
              positiveSignals: ["baseline positive feedback rule"],
              negativeSignals: [],
              modelName: "baseline-positive-feedback",
            },
            passed: true,
          },
          {
            name: "helm-debug-guess",
            expectPromote: false,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 2,
              knowledgeRef: "knowledge:helm-debug-guess",
              content:
                "---\ndescription: Helm upgrade might need --debug\nobserved_at: 2026-04-05\nsources:\n  - memory:helm-debug-guess\n  - skill:helm\n---\n\nIt might help to add --debug to helm upgrade output during failures.\n",
              blockedBy: [],
              positiveSignals: ["baseline positive feedback rule"],
              negativeSignals: [],
              modelName: "baseline-positive-feedback",
            },
            passed: false,
          },
          {
            name: "terraform-state-location",
            expectPromote: true,
            assessment: {
              applicable: true,
              promote: true,
              score: 3,
              threshold: 2,
              knowledgeRef: "knowledge:terraform-state-location",
              content:
                "---\ndescription: Use remote state locks\ntags:\n  - terraform\nobserved_at: 2026-04-04\nsources:\n  - memory:terraform-state-location\n  - skill:terraform\n---\n\nUse remote state with locking enabled before applying shared Terraform stacks.\n",
              blockedBy: [],
              positiveSignals: ["baseline positive feedback rule"],
              negativeSignals: [],
              modelName: "baseline-positive-feedback",
            },
            passed: true,
          },
          {
            name: "mixed-signal-rollback",
            expectPromote: false,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 2,
              knowledgeRef: "knowledge:mixed-signal-rollback",
              content:
                "---\ndescription: Rollback the cluster immediately\nobserved_at: 2026-04-03\nsources:\n  - memory:mixed-signal-rollback\n  - skill:incident\n---\n\nRollback the cluster immediately after any 5xx spike.\n",
              blockedBy: [],
              positiveSignals: ["baseline positive feedback rule"],
              negativeSignals: [],
              modelName: "baseline-positive-feedback",
            },
            passed: false,
          },
          {
            name: "cache-ttl-fact",
            expectPromote: true,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 2,
              knowledgeRef: "knowledge:cache-ttl-fact",
              content:
                "---\ndescription: Cache TTL defaults to five minutes\ntags:\n  - cache\n  - platform\nobserved_at: 2026-04-02\nsources:\n  - memory:cache-ttl-fact\n  - skill:platform\n---\n\nThe shared platform cache TTL defaults to five minutes unless the service opts out.\n",
              blockedBy: [],
              positiveSignals: ["baseline positive feedback rule"],
              negativeSignals: [],
              modelName: "baseline-positive-feedback",
            },
            passed: true,
          },
          {
            name: "personal-shell-alias",
            expectPromote: false,
            assessment: {
              applicable: true,
              promote: false,
              score: 0,
              threshold: 2,
              knowledgeRef: "knowledge:personal-shell-alias",
              blockedBy: ["subjective-memory"],
              positiveSignals: [],
              negativeSignals: [],
              modelName: "baseline-positive-feedback",
            },
            passed: true,
          },
        ],
      },
      noWorseThanSelected: true,
      strictWin: true,
      strictWinMetrics: ["f1", "netOutcomeScore", "accuracy"],
    },
    {
      name: "baseline-metadata",
      heldOut: {
        total: 7,
        correct: 5,
        falsePositives: 2,
        falseNegatives: 0,
        accuracy: 0.7142857142857143,
        precision: 0.6666666666666666,
        recall: 1,
        f1: 0.8,
        truePositives: 4,
        trueNegatives: 1,
        netOutcomeScore: 4,
        capturedPromoteValue: 14,
        preventedFalsePromotionCost: 4,
        results: [
          {
            name: "kafka-rebalance-note",
            expectPromote: true,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 3,
              knowledgeRef: "knowledge:kafka-rebalance-note",
              content:
                "---\ndescription: Pause consumers during rebalance\ntags:\n  - kafka\n  - ops\nobserved_at: 2026-04-08\nsources:\n  - memory:kafka-rebalance-note\n  - skill:kafka\n---\n\nPause consumers during partition rebalances to avoid duplicate processing while assignments settle.\n",
              blockedBy: [],
              positiveSignals: ["baseline metadata rule"],
              negativeSignals: [],
              modelName: "baseline-metadata",
            },
            passed: true,
          },
          {
            name: "gha-token-scope",
            expectPromote: true,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 3,
              knowledgeRef: "knowledge:gha-token-scope",
              content:
                "---\ndescription: Minimize GitHub token scopes\ntags:\n  - gha\n  - security\nobserved_at: 2026-04-07\nsources:\n  - memory:gha-token-scope\n  - skill:github-actions\n---\n\nUse the narrowest GitHub token scope that still allows the workflow step to succeed.\n",
              blockedBy: [],
              positiveSignals: ["baseline metadata rule"],
              negativeSignals: [],
              modelName: "baseline-metadata",
            },
            passed: true,
          },
          {
            name: "helm-debug-guess",
            expectPromote: false,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 3,
              knowledgeRef: "knowledge:helm-debug-guess",
              content:
                "---\ndescription: Helm upgrade might need --debug\nobserved_at: 2026-04-05\nsources:\n  - memory:helm-debug-guess\n  - skill:helm\n---\n\nIt might help to add --debug to helm upgrade output during failures.\n",
              blockedBy: [],
              positiveSignals: ["baseline metadata rule"],
              negativeSignals: [],
              modelName: "baseline-metadata",
            },
            passed: false,
          },
          {
            name: "terraform-state-location",
            expectPromote: true,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 3,
              knowledgeRef: "knowledge:terraform-state-location",
              content:
                "---\ndescription: Use remote state locks\ntags:\n  - terraform\nobserved_at: 2026-04-04\nsources:\n  - memory:terraform-state-location\n  - skill:terraform\n---\n\nUse remote state with locking enabled before applying shared Terraform stacks.\n",
              blockedBy: [],
              positiveSignals: ["baseline metadata rule"],
              negativeSignals: [],
              modelName: "baseline-metadata",
            },
            passed: true,
          },
          {
            name: "mixed-signal-rollback",
            expectPromote: false,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 3,
              knowledgeRef: "knowledge:mixed-signal-rollback",
              content:
                "---\ndescription: Rollback the cluster immediately\nobserved_at: 2026-04-03\nsources:\n  - memory:mixed-signal-rollback\n  - skill:incident\n---\n\nRollback the cluster immediately after any 5xx spike.\n",
              blockedBy: [],
              positiveSignals: ["baseline metadata rule"],
              negativeSignals: [],
              modelName: "baseline-metadata",
            },
            passed: false,
          },
          {
            name: "cache-ttl-fact",
            expectPromote: true,
            assessment: {
              applicable: true,
              promote: true,
              score: 2,
              threshold: 3,
              knowledgeRef: "knowledge:cache-ttl-fact",
              content:
                "---\ndescription: Cache TTL defaults to five minutes\ntags:\n  - cache\n  - platform\nobserved_at: 2026-04-02\nsources:\n  - memory:cache-ttl-fact\n  - skill:platform\n---\n\nThe shared platform cache TTL defaults to five minutes unless the service opts out.\n",
              blockedBy: [],
              positiveSignals: ["baseline metadata rule"],
              negativeSignals: [],
              modelName: "baseline-metadata",
            },
            passed: true,
          },
          {
            name: "personal-shell-alias",
            expectPromote: false,
            assessment: {
              applicable: true,
              promote: false,
              score: 0,
              threshold: 2,
              knowledgeRef: "knowledge:personal-shell-alias",
              blockedBy: ["subjective-memory"],
              positiveSignals: [],
              negativeSignals: [],
              modelName: "baseline-metadata",
            },
            passed: true,
          },
        ],
      },
      noWorseThanSelected: true,
      strictWin: true,
      strictWinMetrics: ["f1", "netOutcomeScore", "accuracy"],
    },
  ],
  strictlyBeatsBaselines: true,
};

const SELECTED_MODEL = CANDIDATE_MODELS.find(
  (model) => model.name === DEFAULT_PROMOTION_POLICY_SELECTION.selectedModel.name,
) as PromotionModelConfig;

export const DEFAULT_PROMOTION_POLICY: PromotionEvaluationPolicy = {
  name: DEFAULT_PROMOTION_POLICY_SELECTION.selectedModel.name,
  threshold: DEFAULT_PROMOTION_POLICY_SELECTION.selectedModel.threshold,
  assess: (input) =>
    assessWithWeightedModel(input, SELECTED_MODEL, DEFAULT_PROMOTION_POLICY_SELECTION.selectedModel.threshold),
};

export function getDefaultPromotionPolicySelection(): PromotionPolicySelectionResult {
  return DEFAULT_PROMOTION_POLICY_SELECTION;
}

export function assessMemoryKnowledgePromotionCandidate(input: PromotionPolicyInput): MemoryPromotionAssessment {
  return DEFAULT_PROMOTION_POLICY.assess(input);
}
