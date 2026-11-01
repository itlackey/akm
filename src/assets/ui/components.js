// Markup builders shared by the pages: they return `html` and hold no state, fetch nothing and attach no listeners.

import { ApiError, html } from "./lib.js";

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

/**
 * Ranked rows, each a label, a bar drawn to scale against `max`, and its figures; for a handful of rows a chart is
 * overkill. A row is `{ name, value, text, tone?, note? }`.
 */
export function barList(rows, { max, label }) {
  return html`<ul class="bar-list" aria-label="${label}">${rows.map(
    (row) =>
      html`<li><span class="bar-name">${row.name}</span><span class="bar-track" aria-hidden="true"><span class="bar-fill" data-tone="${row.tone ?? ""}" style="--w:${max ? Math.max(row.value / max, row.value ? 0.02 : 0) : 0}"></span></span><span class="bar-value num">${row.text}</span>${row.note ? html`<span class="bar-note muted small">${row.note}</span>` : ""}</li>`,
  )}</ul>`;
}
