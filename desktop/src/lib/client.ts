export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = "", status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

import type { Asset, AssetSummary } from "./types";
export async function api<T = unknown>(path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== ""));
  const response = await fetch(
    `/api${path}${params.size ? `?${params}` : ""}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? "The request failed.", data.code ?? "", response.status);
  return data.ok === true && Object.hasOwn(data, "data") ? data.data : data;
}
export function title(asset?: AssetSummary): string {
  const explicit = asset?.title ?? asset?.metadata?.title ?? asset?.frontmatter?.title;
  return typeof explicit === "string" && explicit
    ? explicit
    : asset?.name?.replace(/[-_]/g, " ") || asset?.ref?.split("/").pop()?.replace(/[-_]/g, " ") || "Untitled asset";
}
export function bodyOf(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}
/** Match a search hit to a durable URL without conflating identical paths in different bundles. */
export function matchesAssetRef(hit: AssetSummary, ref: string, defaultBundle: string): boolean {
  const qualify = (value: string, bundle: string) => (value.includes("//") || !bundle ? value : `${bundle}//${value}`);
  return qualify(hit.ref, hit.origin || defaultBundle) === qualify(ref, defaultBundle);
}
/** Same display contract as akm ui: documents, command templates, and agent prompts. */
export function assetSource(asset?: Partial<Asset> | null): string {
  return asset?.content || asset?.template || asset?.prompt || "";
}
export function date(value: unknown): string {
  if (typeof value !== "string" || !value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}
export function saveContent(source: string, draft: string): string {
  if (draft === source.replace(/\r\n?/g, "\n")) return source;
  return source.includes("\r\n") && !/[\r\n]/.test(source.replace(/\r\n/g, ""))
    ? draft.replace(/\r?\n/g, "\r\n")
    : draft;
}
export function toggleSelection(selected: string[], id: string, max = Infinity): string[] {
  return selected.includes(id)
    ? selected.filter((item) => item !== id)
    : selected.length < max
      ? [...selected, id]
      : selected;
}
/** A bounded, integer-only scale for count charts, including the single-event case. */
export function countAxis(observedMaximum: number): { maximum: number; ticks: number[] } {
  const observed = Number.isFinite(observedMaximum) ? Math.max(1, Math.ceil(observedMaximum)) : 1;
  const roughStep = observed / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const factor = [1, 2, 5, 10].find((value) => value * magnitude >= roughStep) ?? 10;
  const step = Math.max(1, factor * magnitude);
  const maximum = Math.ceil(observed / step) * step;
  return { maximum, ticks: Array.from({ length: Math.round(maximum / step) + 1 }, (_, index) => index * step) };
}
