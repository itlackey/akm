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

/** Say `message` once to assistive technology, through the page's one polite status region. */
export function announce(message) {
  const region = document.getElementById("route-status");
  if (region) region.textContent = message;
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

/** Send one request and resolve to the response's `data`; failures are an {@link ApiError} with the server's `code`. */
async function request(url, init) {
  let response;
  try {
    response = await fetch(url, init);
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

/** GET `path` with optional query values (empty ones are dropped); resolves to the response's `data`. */
let routeSignal = null;

/** The signal every `api()` read aborts with: the router sets one per page, and aborts it when the reader navigates away. */
export function setRouteSignal(signal) {
  routeSignal = signal;
}

/**
 * GET `path` and return its `data`. A read is tied to the page on screen and is abandoned when the reader leaves it;
 * pass `{ signal: null }` for one that must outlive the page (the sidebar's count).
 */
export function api(path, query = {}, { signal } = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const url = search.size > 0 ? `${path}?${search}` : path;
  return request(url, {
    headers: { "X-Akm-Ui-Token": token ?? "" },
    cache: "no-store",
    signal: signal === undefined ? (routeSignal ?? undefined) : signal,
  });
}

/** POST `body` as JSON to an explicit action. The token goes in the header, never the URL. */
export function post(path, body = {}) {
  return request(path, {
    method: "POST",
    headers: { "X-Akm-Ui-Token": token ?? "", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

let metaPromise = null;
/** `/api/meta`, fetched once. */
export function getMeta() {
  if (!metaPromise) {
    metaPromise = api("/api/meta", {}, { signal: null });
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

/** A file path that may break after each slash, so a long absolute path wraps in a narrow column instead of overflowing. */
export function pathText(value) {
  const parts = String(value ?? "").split("/");
  return html`<span class="mono">${parts.map((part, i) => (i === 0 ? part : html`/<wbr>${part}`))}</span>`;
}

/** The Monday (00:00 UTC) of the week holding `iso`, as YYYY-MM-DD. */
export function weekStart(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** A relative time; the absolute time is its tooltip and is also in the text for a reader who cannot hover. */
export function when(iso) {
  return html`<time datetime="${iso ?? ""}" title="${fmtDateTime(iso)}">${ago(iso)}<span class="sr-only"> (${fmtDateTime(iso)})</span></time>`;
}

// ---- small building blocks -------------------------------------------------

export function assetHref(ref, returnTo = "") {
  return `#/asset?ref=${encodeURIComponent(ref)}${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`;
}

export function proposalHref(id, query = "") {
  return `#/proposals/${encodeURIComponent(id)}${String(query) ? `?${query}` : ""}`;
}

/** Only a search route is a document's return destination, never an arbitrary URL. */
export function searchReturn(query) {
  const value = query.get("returnTo") ?? "";
  return /^#\/search(?:\?|$)/.test(value) ? value : "";
}

// The shared markup builders live in components.js; they are re-exported here so pages keep one import.
export {
  badge,
  definitionList,
  emptyState,
  errorState,
  loadingState,
  pageHeader,
  statusKind,
  tableWrap,
} from "./components.js";

export function pretty(value) {
  return JSON.stringify(value, null, 2);
}

export function percent(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

// ---- unsaved drafts and one-shot status ------------------------------------

let unsaved = false;
/** The editor marks a draft that leaving the page would lose; the router asks before discarding it. */
export function setUnsaved(value) {
  unsaved = value;
}
export function hasUnsaved() {
  return unsaved;
}

let flash = null;
export function setFlash(message) {
  flash = message;
}
/** Show the status a form left before its page re-rendered, once. Called by the router after each render. */
export function showFlash(root) {
  const pending = flash;
  flash = null;
  if (typeof pending === "string") {
    const status = document.createElement("div");
    mount(status, html`<p role="status" class="notice notice-ok">${pending}</p>`);
    root.prepend(status);
    return;
  }
  const status = pending && root.querySelectorAll(pending.selector)[pending.index]?.querySelector("[data-status]");
  if (status) mount(status, html`<p role="status" class="text-ok">${pending.message}</p>`);
}

/** Bind an explicit form action; errors stay beside the user's inputs. */
export function actionForm(root, selector, action, { after } = {}) {
  root.querySelectorAll(selector).forEach((form, index) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = form.querySelector("[data-status]");
      const button = event.submitter;
      let locked = false;
      if (button) button.disabled = true;
      if (status) mount(status, html`<p role="status">Working…</p>`);
      try {
        const result = await action(form, new FormData(form));
        const message = result?.saved === false ? "No changes." : "Saved.";
        if (status) mount(status, html`<p role="status" class="text-ok">${message}</p>`);
        if (after) after(result);
        else {
          flash = { selector, index, message };
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }
      } catch (error) {
        // The action may already have happened; the server asks not to repeat it without a reload.
        locked = error?.code === "INVALID_COMMAND_RESPONSE";
        if (status) mount(status, html`<p role="alert" class="text-fail">${error.message}</p>`);
      } finally {
        if (button && !locked) button.disabled = false;
      }
    });
  });
}
