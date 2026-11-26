// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What a reflect reply is: its two shapes (JSON Schema, framed text) read into one payload, and the patch it carries. */

import { parseEmbeddedJsonResponse } from "../../core/parse";
import { ENRICHED_PATCH_FIELDS, enrichedPatchFields } from "./memory-enrichment";

/** What a reflect reply changes; a field it leaves out stays as the source has it. */
export interface ReflectPatch {
  description?: string;
  when_to_use?: string;
  /** The text of a level-1 heading, added only to a body that has none. */
  title?: string;
  /** A memory's tags, only when `experimental.memoryEnrichment` is on. */
  tags?: string[];
}

function parseReflectConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('direct reflect response missing required number field "confidence" in [0, 1]');
  }
  return value;
}

export const REFLECT_PATCH_FIELDS = ["description", "when_to_use", "title"] as const;

/** A parsed reflect reply: the asset it names, its confidence, and the fields it changes. */
export interface ReflectPayload {
  ref: string;
  confidence: number;
  patch: ReflectPatch;
}

function parseReflectFrontmatterPatch(value: unknown, enrichMemory: boolean): ReflectPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('direct reflect response missing required object field "frontmatterPatch"');
  }
  const fields = value as Record<string, unknown>;
  const names = enrichMemory ? [...REFLECT_PATCH_FIELDS, ...ENRICHED_PATCH_FIELDS] : REFLECT_PATCH_FIELDS;
  if (Object.keys(fields).length !== names.length || names.some((f) => !(f in fields))) {
    throw new Error(`direct reflect frontmatterPatch fields must be exactly: ${names.join(", ")}`);
  }
  const patch: ReflectPatch = {};
  for (const field of REFLECT_PATCH_FIELDS) {
    const fieldValue = fields[field];
    if (fieldValue === null || (typeof fieldValue === "string" && fieldValue.trim().toLowerCase() === "null")) continue;
    if (typeof fieldValue !== "string" || !fieldValue.trim() || /[\r\n]/.test(fieldValue)) {
      throw new Error(`direct reflect frontmatterPatch.${field} must be a non-empty single-line string or null`);
    }
    patch[field] = fieldValue.trim();
  }
  return enrichMemory ? { ...patch, ...enrichedPatchFields(fields) } : patch;
}

export function parseSchemaReflectOutput(
  raw: string,
  targetRef: string | undefined,
  enrichMemory: boolean,
): ReflectPayload {
  const parsed = parseEmbeddedJsonResponse<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("direct reflect response was not valid JSON");
  }
  const expectedKeys = targetRef ? ["confidence", "frontmatterPatch"] : ["confidence", "frontmatterPatch", "ref"];
  const actualKeys = Object.keys(parsed).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`direct reflect response fields must be exactly: ${expectedKeys.join(", ")}`);
  }
  const ref = targetRef ?? (typeof parsed.ref === "string" ? parsed.ref.trim() : "");
  if (!ref) throw new Error('direct reflect response missing required string field "ref"');
  return {
    ref,
    confidence: parseReflectConfidence(parsed.confidence),
    patch: parseReflectFrontmatterPatch(parsed.frontmatterPatch, enrichMemory),
  };
}

export function parseFramedReflectOutput(
  raw: string,
  targetRef: string | undefined,
  enrichMemory: boolean,
): ReflectPayload {
  const headerLines = raw.replaceAll("\r\n", "\n").trim().split("\n").filter(Boolean);
  const header = (prefix: string) => headerLines.find((line) => line.startsWith(prefix));
  const confidenceLine = header("AKM_REFLECT_CONFIDENCE:");
  const refLine = header("AKM_REFLECT_REF:");
  const patchLine = header("AKM_REFLECT_FRONTMATTER_PATCH:");
  const invalidRefLine = targetRef ? refLine !== undefined : refLine === undefined;
  if (headerLines.length !== (targetRef ? 2 : 3) || !confidenceLine || !patchLine || invalidRefLine) {
    throw new Error("direct reflect response contained invalid frame metadata");
  }
  const confidenceText = confidenceLine.slice("AKM_REFLECT_CONFIDENCE:".length).trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText)) {
    throw new Error("direct reflect frame confidence must be a decimal number in [0, 1]");
  }
  const ref = targetRef ?? refLine?.slice("AKM_REFLECT_REF:".length).trim() ?? "";
  if (!ref) throw new Error("direct reflect response contained an empty AKM_REFLECT_REF value");
  let parsedPatch: unknown;
  try {
    parsedPatch = JSON.parse(patchLine.slice("AKM_REFLECT_FRONTMATTER_PATCH:".length).trim());
  } catch {
    throw new Error("direct reflect response contained invalid frontmatter patch JSON");
  }
  return {
    ref,
    confidence: parseReflectConfidence(Number(confidenceText)),
    patch: parseReflectFrontmatterPatch(parsedPatch, enrichMemory),
  };
}
