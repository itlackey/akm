// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

// Where the UI is served from: "" at the root of a site, "/akm" when a proxy serves it under that path and removes it
// before forwarding. Kit works it out from the page's address (`$app/paths`); `navigation.ts` hands it over, so that
// this module needs no Kit import. Links, navigation and API calls keep app paths ("/library/search") and add it here.
let root = "";
export function setRoot(base: string) {
  root = base;
}
/** An app path ("/library/search?q=a") as an address the browser can follow; anything else is returned as it is. */
export function appHref(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") ? root + path : path;
}
/** The app path of a browser pathname: the reverse of `appHref`. */
export function appPath(pathname: string): string {
  return root && pathname.startsWith(`${root}/`) ? pathname.slice(root.length) : pathname;
}
export async function api<T = unknown>(path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== ""));
  const response = await fetch(
    appHref(`/api${path}${params.size ? `?${params}` : ""}`),
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
/** akm says its state database cannot be read: there is none yet, or it needs a migration first. */
export type StateUnavailable = { available: false; reason: "absent" | "needs-migration" };
export function stateUnavailableText(state: StateUnavailable): string {
  return state.reason === "absent"
    ? "AKM has no state database yet."
    : "AKM's state database needs a migration first: run `akm migrate apply`.";
}
/** A read that needs akm's state database. When akm cannot read it that is a failure with its reason, never an empty result. */
export async function apiState<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const data = await api<T | StateUnavailable>(path, query);
  if ((data as StateUnavailable).available === false) throw new Error(stateUnavailableText(data as StateUnavailable));
  return data as T;
}
/** The folder the person picks in the operating system's dialog (AKM Desktop app only), or null when they cancel. */
export async function pickFolder(start = ""): Promise<string | null> {
  return (await api<{ path: string | null }>("/desktop/pick-folder", {}, start ? { start } : {})).path;
}
export function title(asset?: AssetSummary): string {
  const explicit = asset?.title ?? asset?.metadata?.title ?? asset?.frontmatter?.title;
  return typeof explicit === "string" && explicit
    ? explicit
    : asset?.name?.replace(/[-_]/g, " ") || asset?.ref?.split("/").pop()?.replace(/[-_]/g, " ") || "Untitled asset";
}
/** Match a search hit to a durable URL without conflating identical paths in different bundles. */
export function matchesAssetRef(hit: AssetSummary, ref: string, defaultBundle: string): boolean {
  const qualify = (value: string, bundle: string) => (value.includes("//") || !bundle ? value : `${bundle}//${value}`);
  return qualify(hit.ref, hit.origin || defaultBundle) === qualify(ref, defaultBundle);
}
/** The display contract for documents, command templates, and agent prompts. */
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
