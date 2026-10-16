// Shared helpers for the akm ui client: HTML escaping, the API client, formatting.
//
// Every string that reaches the DOM goes through `html` (a tagged template that
// escapes each interpolated value) and `mount` (the only place in the client
// that writes markup into the page). Nothing else assigns markup, so reading
// this file is enough to audit how page content is escaped.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for use in element content or a quoted attribute value. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Markup that is already safe: only `html` creates one. */
class SafeHtml {
  constructor(text) {
    this.text = text;
  }
}

function part(value) {
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(part).join("");
  if (value === null || value === undefined || value === false) return "";
  return esc(value);
}

/** Tagged template: literal parts are trusted markup, every interpolated value is escaped unless it is itself `html`. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Replace the contents of `element` with `safe`. The one markup write in the client. */
export function mount(element, safe) {
  if (!(safe instanceof SafeHtml)) throw new TypeError("mount() takes the result of html``");
  element.innerHTML = safe.text;
}

// ---- token and API client --------------------------------------------------

const TOKEN_KEY = "akm-ui-token";
let token = null;

/** Read the launch token from the URL (then drop it from the address bar) or from sessionStorage. */
export function initToken() {
  const params = new URLSearchParams(location.search);
  token = params.get("token");
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // sessionStorage can be unavailable; the URL token still works for this load.
  }
  if (params.has("token")) history.replaceState(null, "", location.pathname + location.hash);
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** GET `path` with optional query values (empty ones are dropped); resolves to the response's `data`. */
export async function api(path, query = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const url = search.size > 0 ? `${path}?${search}` : path;
  let response;
  try {
    response = await fetch(url, { headers: { "X-Akm-Ui-Token": token ?? "" }, cache: "no-store" });
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the akm ui server. It may have stopped; run `akm ui` again.");
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Fall through to the generic error below.
  }
  if (response.status === 401) {
    throw new ApiError(401, "UNAUTHORIZED", "The session token is missing or no longer valid.");
  }
  if (!body || body.ok !== true) {
    throw new ApiError(
      response.status,
      body?.code ?? "BAD_RESPONSE",
      body?.error ?? `Unexpected response (HTTP ${response.status}).`,
    );
  }
  return body.data;
}

let metaPromise = null;
/** `/api/meta`, fetched once. */
export function getMeta() {
  if (!metaPromise) {
    metaPromise = api("/api/meta");
    metaPromise.catch(() => {
      metaPromise = null;
    });
  }
  return metaPromise;
}

// ---- formatting ------------------------------------------------------------

export function fmtNum(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "-";
}

export function fmtPct(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "-";
}

export function fmtMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

/** "3h ago" style age of an ISO timestamp. */
export function ago(iso) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return "-";
  const seconds = Math.round((Date.now() - t) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function fmtDateTime(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? "-" : new Date(t).toLocaleString();
}

/** A relative time with the absolute time as its tooltip. */
export function when(iso) {
  return html`<time datetime="${iso ?? ""}" title="${fmtDateTime(iso)}">${ago(iso)}</time>`;
}

// ---- small building blocks -------------------------------------------------

export function assetHref(ref) {
  return `#/asset?ref=${encodeURIComponent(ref)}`;
}

export function proposalHref(id) {
  return `#/proposals/${encodeURIComponent(id)}`;
}

/** Status pill: `kind` is ok | warn | fail | neutral | info. */
export function badge(text, kind = "neutral") {
  return html`<span class="badge badge-${kind}">${text}</span>`;
}

export function statusKind(status) {
  if (status === "pass" || status === "ok") return "ok";
  if (status === "warn") return "warn";
  if (status === "fail") return "fail";
  return "neutral";
}

export function tableWrap(inner) {
  return html`<div class="table-wrap">${inner}</div>`;
}

export function emptyState(title, detail = "") {
  return html`<div class="state state-empty"><p class="state-title">${title}</p>${detail ? html`<p>${detail}</p>` : ""}</div>`;
}

export function loadingState(label = "Loading") {
  return html`<div class="state state-loading" role="status"><span class="spinner" aria-hidden="true"></span>${label}...</div>`;
}

export function errorState(error) {
  if (error instanceof ApiError && error.status === 401) {
    return html`<div class="state state-error" role="alert">
      <p class="state-title">Not signed in</p>
      <p>${error.message} Open the URL printed by <code>akm ui</code> (it ends in <code>?token=...</code>) to start a session.</p>
    </div>`;
  }
  const code = error instanceof ApiError ? error.code : "ERROR";
  const message = error instanceof Error ? error.message : String(error);
  return html`<div class="state state-error" role="alert">
    <p class="state-title">Could not load this page</p>
    <p>${message}</p>
    <p class="muted"><code>${code}</code></p>
  </div>`;
}

export function pageHeader(title, subtitle = "") {
  return html`<header class="page-head"><h1>${title}</h1>${subtitle ? html`<p class="muted">${subtitle}</p>` : ""}</header>`;
}

/** A definition list from [label, value] pairs; null/undefined/empty values are skipped. */
export function definitionList(pairs) {
  const rows = pairs.filter(([, value]) => value !== null && value !== undefined && value !== "");
  return html`<dl class="kv">${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

export function pretty(value) {
  return JSON.stringify(value, null, 2);
}

export function percent(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}
