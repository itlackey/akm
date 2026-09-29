// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { assembleAsset } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { parseRefInput } from "../../core/asset/resolve-ref";

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
  const parsed = parseRefInput(inputRef);
  const leaf = parsed.name.split("/").filter(Boolean).at(-1) ?? parsed.name;
  const safe = leaf
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `knowledge/${safe}`;
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
  const parsed = parseRefInput(input.inputRef);
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
  const xrefs = [input.inputRef];
  if (typeof fm.source === "string" && fm.source.trim()) xrefs.push(fm.source.trim());
  const knowledgeFrontmatter: Record<string, unknown> = {
    ...(normalizedDescription ? { description: normalizedDescription } : {}),
    ...(Array.isArray(fm.tags) ? { tags: fm.tags } : {}),
    ...(typeof fm.observed_at === "string" && fm.observed_at.trim() ? { observed_at: fm.observed_at.trim() } : {}),
    xrefs,
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

/**
 * The memory → knowledge promotion model: a weighted score over feedback
 * reinforcement and memory metadata, promoted at or above the threshold. The
 * weights were chosen by a grid search over a labelled corpus; they are a
 * plain constant now.
 */
const PROMOTION_MODEL: PromotionModelConfig = {
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
};
const PROMOTION_THRESHOLD = 3.8;

export function assessMemoryKnowledgePromotionCandidate(input: PromotionPolicyInput): MemoryPromotionAssessment {
  return assessWithWeightedModel(input, PROMOTION_MODEL, PROMOTION_THRESHOLD);
}
