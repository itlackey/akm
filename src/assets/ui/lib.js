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

// ---- markup builders shared by the pages ----------------------------------------
// They return `html`, hold no state, fetch nothing and attach no listeners.

/** Status pill: `tone` is ok | warn | fail | neutral | info. Always text, never colour alone. */
export function badge(text, tone = "neutral") {
  return html`<span class="badge" data-tone="${tone}">${text}</span>`;
}

export function statusKind(status) {
  if (status === "pass" || status === "ok") return "ok";
  if (status === "warn") return "warn";
  if (status === "fail") return "fail";
  return "neutral";
}

export function tableWrap(inner) {
  // Focusable, so a keyboard user can scroll a table that is wider than its column.
  return html`<div class="table-wrap" tabindex="0" role="group" aria-label="Table">${inner}</div>`;
}

/** The "Data and details" disclosure under a chart: the same figures as a table. */
export function dataTable(content) {
  return html`<details><summary>Data and details</summary>${content}</details>`;
}

/** A chart's key. An item is `[label, series]`: `series` is the colour's 1-based number, or absent for a note. */
export function legend(items) {
  return html`<p class="chart-legend">${items.map(
    ([label, series]) =>
      html`<span>${series === undefined ? "" : html`<i class="series-key series-${series}" aria-hidden="true"></i>`}${label}</span>`,
  )}</p>`;
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

/** The "N sections could not load" notice for a response that lists the sections that failed as `{ name: message }`. */
export function sectionErrors(errors) {
  const entries = Object.entries(errors ?? {});
  return entries.length === 0
    ? ""
    : html`<details class="notice notice-warn"><summary>${entries.length} sections could not load</summary><ul>${entries.map(([name, message]) => html`<li><span class="mono">${name}</span>: ${message}</li>`)}</ul></details>`;
}

/** A page's heading; `controls` sit beside it. */
export function pageHeader(title, subtitle = "", controls = "") {
  const heading = html`<h1>${title}</h1>${subtitle ? html`<p class="muted">${subtitle}</p>` : ""}`;
  return controls
    ? html`<header class="page-head page-head-row"><div>${heading}</div>${controls}</header>`
    : html`<header class="page-head">${heading}</header>`;
}

/**
 * A choice of time window. Choosing one moves the page to `#/<route>?<param>=<value>`: the router does the move (it
 * reads `data-hash`), so the page attaches nothing. `choices` is `[[value, label]]`.
 */
export function windowToggle({ route, param, label, current, choices }) {
  return html`<fieldset class="segmented" aria-label="${label}">${choices.map(
    ([value, text]) =>
      html`<label><input type="radio" name="${param}" value="${value}" data-hash="#/${route}?${param}=${value}" ${current === value ? html`checked` : ""}><span>${text}</span></label>`,
  )}</fieldset>`;
}

/** A definition list from [label, value] pairs; null/undefined/empty values are skipped. */
export function definitionList(pairs) {
  const rows = pairs.filter(([, value]) => value !== null && value !== undefined && value !== "");
  return html`<dl class="kv">${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

/**
 * Parts side by side, each as wide as its `n`, in a bar that fills `fraction` of its track. A part is
 * `{ n, cls, title }`. With a `label` the bar is a named image; without one it decorates figures printed beside it.
 */
export function stackedBar(parts, { fraction = 1, label = "" } = {}) {
  return html`<span class="bar-track" ${label ? html`role="img" aria-label="${label}"` : html`aria-hidden="true"`}><span class="bar-stack" style="--w:${fraction}">${parts
    .filter((part) => part.n > 0)
    .map((part) => html`<span class="${part.cls}" style="--w:${part.n}" title="${part.title}"></span>`)}</span></span>`;
}

/**
 * Ranked rows, each a label, a bar drawn to scale against `max`, and its figures; for a handful of rows a chart is
 * overkill. A row is `{ name, value, text, tone?, note?, parts? }`; `parts` (see {@link stackedBar}) split its bar.
 */
export function barList(rows, { max, label }) {
  return html`<ul class="bar-list" aria-label="${label}">${rows.map((row) => {
    const fraction = max ? Math.max(row.value / max, row.value ? 0.02 : 0) : 0;
    return html`<li><span class="bar-name">${row.name}</span>${
      row.parts
        ? stackedBar(row.parts, { fraction })
        : html`<span class="bar-track" aria-hidden="true"><span class="bar-fill" data-tone="${row.tone ?? ""}" style="--w:${fraction}"></span></span>`
    }<span class="bar-value num">${row.text}</span>${row.note ? html`<span class="bar-note muted small">${row.note}</span>` : ""}</li>`;
  })}</ul>`;
}

/**
 * Send a filter form's filled fields to `#/<route>?...` on submit or when a select changes. Submitting an unchanged
 * form routes again, so the page redraws.
 */
export function wireFilterForm(form, route) {
  const go = () => {
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) if (value) params.set(key, String(value));
    const next = `#/${route}${params.size > 0 ? `?${params}` : ""}`;
    if (location.hash === next) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else location.hash = next;
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    go();
  });
  for (const select of form.querySelectorAll("select")) select.addEventListener("change", go);
}

/** True when a switch no longer matches the `data-initial` it was drawn with. */
export function switchChanged(input) {
  return input.checked !== (input.dataset.initial === "true");
}

export function pretty(value) {
  return JSON.stringify(value, null, 2);
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
