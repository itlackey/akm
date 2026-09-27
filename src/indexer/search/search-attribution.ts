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
}

export interface UsageEventAttribution {
  memoryInference?: {
    exposure: "direct" | "surface";
    childRef: string;
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
  const memoryInference = (from as AttributionHost)[ATTRIBUTION]?.memoryInference;
  if (!memoryInference) return;
  const memorySurvives =
    memoryInference.exposure !== "surface" ||
    (memoryInference.surfaceDescription !== undefined && memoryInference.surfaceDescription === outputDescription);
  if (memorySurvives) attachSearchHitAttribution(to, { memoryInference });
}

export function getSearchHitAttribution(target: object): SearchHitAttribution | undefined {
  return (target as AttributionHost)[ATTRIBUTION];
}

export function buildUsageEventAttribution(
  attribution: SearchHitAttribution | undefined,
  entryRef: string,
  projection: AttributionProjection = "full",
): UsageEventAttribution | undefined {
  const memoryInference = attribution?.memoryInference;
  if (!memoryInference) return undefined;
  const childRef = memoryInference.exposure === "direct" ? entryRef : memoryInference.childRef;
  const surfaceFields = memoryInference.surfaceFields ?? [];
  const surfaceVisible =
    memoryInference.exposure !== "surface" ||
    (projection === "full"
      ? surfaceFields.length > 0
      : projection === "normal" || projection === "agent"
        ? surfaceFields.includes("description")
        : false);
  if (childRef?.includes("//") !== true || !surfaceVisible) return undefined;
  return { memoryInference: { exposure: memoryInference.exposure, childRef } };
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
