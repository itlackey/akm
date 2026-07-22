// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export interface SearchHitAttribution {
  memoryInference?: {
    exposure: "direct" | "surface";
    childRef?: string;
    surfaceFields?: Array<"description" | "tags">;
    surfaceDescription?: string;
  };
  graphExtraction?: {
    boost: number;
    bodyHash?: string;
    extractionRunId?: string;
  };
}

export interface UsageEventAttribution {
  memoryInference?: {
    exposure: "direct" | "surface";
    childRef: string;
  };
  graphExtraction?: {
    boost: number;
    bodyHash?: string;
    extractionRunId?: string;
  };
}

const ATTRIBUTION = Symbol("search-hit-attribution");
type AttributionHost = { [ATTRIBUTION]?: SearchHitAttribution };

export type AttributionProjection = "brief" | "normal" | "full" | "agent";

export function attachSearchHitAttribution(target: object, attribution: SearchHitAttribution): void {
  const host = target as AttributionHost;
  host[ATTRIBUTION] = {
    ...host[ATTRIBUTION],
    ...attribution,
  };
}

export function copySearchHitAttribution(from: object, to: object, outputDescription?: string): void {
  const attribution = (from as AttributionHost)[ATTRIBUTION];
  if (!attribution) return;
  const memoryInference = attribution.memoryInference;
  const memorySurvives =
    memoryInference?.exposure !== "surface" ||
    (memoryInference.surfaceDescription !== undefined && memoryInference.surfaceDescription === outputDescription);
  const applicable = {
    ...(memorySurvives && memoryInference ? { memoryInference } : {}),
    ...(attribution.graphExtraction ? { graphExtraction: attribution.graphExtraction } : {}),
  };
  if (applicable.memoryInference || applicable.graphExtraction) attachSearchHitAttribution(to, applicable);
}

export function getSearchHitAttribution(target: object): SearchHitAttribution | undefined {
  return (target as AttributionHost)[ATTRIBUTION];
}

export function buildUsageEventAttribution(
  attribution: SearchHitAttribution | undefined,
  entryRef: string,
  projection: AttributionProjection = "full",
): UsageEventAttribution | undefined {
  if (!attribution) return undefined;
  const memoryInference = attribution.memoryInference;
  const childRef = memoryInference?.exposure === "direct" ? entryRef : memoryInference?.childRef;
  const graphExtraction = attribution.graphExtraction;
  const graphApplies =
    graphExtraction !== undefined && Number.isFinite(graphExtraction.boost) && graphExtraction.boost > 0;
  const surfaceFields = memoryInference?.surfaceFields ?? [];
  const surfaceVisible =
    memoryInference?.exposure !== "surface" ||
    (projection === "full"
      ? surfaceFields.length > 0
      : projection === "normal" || projection === "agent"
        ? surfaceFields.includes("description")
        : false);
  const memoryApplies = memoryInference !== undefined && childRef?.includes("//") === true && surfaceVisible;
  if (!memoryApplies && !graphApplies) return undefined;
  return {
    ...(memoryApplies
      ? {
          memoryInference: {
            exposure: memoryInference.exposure,
            childRef,
          },
        }
      : {}),
    ...(graphApplies ? { graphExtraction } : {}),
  };
}

export function usageEventAttributionMetadata(
  attribution: SearchHitAttribution | undefined,
  entryRef: string,
  projection: AttributionProjection = "full",
): string | undefined {
  const applicable = buildUsageEventAttribution(attribution, entryRef, projection);
  return JSON.stringify({
    downstreamAttribution: {
      version: 1,
      control: applicable === undefined,
      ...applicable,
    },
  });
}
