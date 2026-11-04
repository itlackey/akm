import { ApiError, assetSource, title } from "./client";
import type { Asset, AssetDetail, AssetSummary, Json } from "./types";
export interface SearchHit extends AssetSummary {
  score?: number;
  tags?: string[];
}
export interface SearchResult {
  hits: SearchHit[];
  warnings?: string[];
  tip?: string;
  searchMode?: string;
  timing?: { totalMs: number };
}
export interface AssetRead extends Omit<AssetDetail, "feedback"> {
  location?: { bundle: string; path: string; parent: string } | null;
  headings?: Array<{ text: string; slug: string; line: number; level?: number }>;
  feedback?: {
    counts: { positive?: number; negative?: number };
    history: Array<{ at: string; signal: string; source: string; reason?: string; tags?: string[] }>;
  };
}
export interface Improvement {
  proposals: Array<{ id: string; source: string; status: string; outcome: string; decidedAt?: string | null }>;
  usageByWeek: Array<{ week: string; hits: number; positive: number; negative: number }>;
}
export function documentTitle(asset?: Asset): string {
  const source = assetSource(asset);
  const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const metadataTitle = front
    ?.match(/^title:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  return (
    metadataTitle ||
    source
      .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
      .match(/^#\s+(.+)$/m)?.[1]
      ?.trim() ||
    title(asset)
  );
}
export function resultContext(query: URLSearchParams): URLSearchParams {
  const returned = query.get("returnTo");
  const params =
    returned && /^#\/search(?:\?|$)/.test(returned)
      ? new URLSearchParams(returned.split("?")[1] ?? "")
      : new URLSearchParams(query);
  for (const key of ["ref", "section", "history", "revision", "returnTo", "compare", "saved"]) params.delete(key);
  return params;
}
export function searchHref(params: URLSearchParams, ref?: string): string {
  const next = new URLSearchParams(params);
  if (ref) next.set("ref", ref);
  else next.delete("ref");
  return `#/search${next.size ? `?${next}` : ""}`;
}
export function typedLinks(
  value: Json | undefined,
): Array<{ direction: string; kind: string; refs: string[]; total: number }> {
  const rows: Array<{ direction: string; kind: string; refs: string[]; total: number }> = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return rows;
  for (const [direction, kinds] of Object.entries(value)) {
    if (!kinds || typeof kinds !== "object" || Array.isArray(kinds)) continue;
    for (const [kind, info] of Object.entries(kinds)) {
      if (!info || typeof info !== "object" || Array.isArray(info)) continue;
      const refs = Array.isArray(info.refs) ? info.refs.filter((r): r is string => typeof r === "string") : [];
      rows.push({ direction, kind, refs, total: typeof info.total === "number" ? info.total : refs.length });
    }
  }
  return rows;
}
export async function libraryRead<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(
    `/api${path}?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== ""))}`,
    { signal },
  );
  const envelope = await response.json();
  if (!response.ok)
    throw new ApiError(envelope.error ?? "Could not read AKM data.", envelope.code ?? "", response.status);
  return (envelope.ok === true && Object.hasOwn(envelope, "data") ? envelope.data : envelope) as T;
}
