// Search: query box with type and bundle filters; results link to the asset view.

import { api, assetHref, badge, emptyState, html, pageHeader } from "./lib.js";

const RESULT_LIMIT = 50;

/** Exactly `values` as options, with `selected` chosen. */
function choices(values, selected) {
  return values.map((v) => html`<option value="${v}" ${v === selected ? html`selected` : ""}>${v}</option>`);
}

function options(values, selected, allLabel) {
  return html`<option value="">${allLabel}</option>${choices(values, selected)}`;
}

function hit(h, returnTo) {
  return html`<li class="hit">
    <div class="hit-head"><a class="mono wrap" href="${assetHref(h.ref, returnTo)}">${h.ref}</a>${badge(h.type, "info")}${h.origin ? html`<span class="muted small">${h.origin}</span>` : ""}${typeof h.score === "number" ? html`<span class="num muted small" title="Ranking score">score ${h.score.toFixed(3)}</span>` : ""}</div>
    ${h.description ? html`<p>${h.description}</p>` : ""}
    ${Array.isArray(h.tags) && h.tags.length > 0 ? html`<div class="tags">${h.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : ""}
    ${Array.isArray(h.whyMatched) && h.whyMatched.length > 0 ? html`<p class="muted small">Matched: ${h.whyMatched.join(", ")}</p>` : ""}
  </li>`;
}

export async function render(ctx) {
  const returnTo = `#/search${ctx.query.size ? `?${ctx.query}` : ""}`;
  const q = ctx.query.get("q") ?? "";
  const type = ctx.query.get("type") ?? "";
  const bundle = ctx.query.get("bundle") ?? "";
  const belief = ctx.query.get("belief") || "current";
  const limit = ctx.query.get("limit") || String(RESULT_LIMIT);
  const scope = Object.fromEntries(
    ["user", "agent", "run", "channel"].map((key) => [`scope_${key}`, ctx.query.get(`scope_${key}`) ?? ""]),
  );
  const [result, bundles] = await Promise.all([
    api("/api/search", { q, type, bundle, belief, ...scope, limit }),
    api("/api/bundles").catch(() => null),
  ]);
  const types = new Set(Object.keys(bundles?.index?.byType ?? {}));
  for (const h of result.hits) types.add(h.type);
  if (type) types.add(type);
  const bundleNames = (bundles?.bundles ?? []).map((b) => b.name);

  ctx.after.push((root) => {
    const form = root.querySelector("form.search-form");
    const go = () => {
      const params = new URLSearchParams();
      for (const [key, value] of new FormData(form)) if (value) params.set(key, String(value));
      const next = `#/search${params.size > 0 ? `?${params}` : ""}`;
      if (location.hash === next) window.dispatchEvent(new HashChangeEvent("hashchange"));
      else location.hash = next;
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      go();
    });
    for (const select of form.querySelectorAll("select")) select.addEventListener("change", go);
  });

  const groups = new Map();
  for (const h of result.hits) {
    const group = h.ref.slice(0, h.ref.lastIndexOf("/")) || h.type;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(h);
  }
  return html`${pageHeader("Search", "Search or browse your indexed assets. Browsing is not counted as usage.")}
    <p class="action-links"><a href="#/new">New knowledge</a> <span class="muted small">· Ctrl/Cmd+K opens search</span></p>
    <form class="search-form" role="search">
      <input type="search" name="q" value="${q}" placeholder="Search assets (empty browses the index)" aria-label="Query" autofocus>
      <select name="type" aria-label="Type">${options([...types].sort(), type, "All types")}</select>
      <select name="bundle" aria-label="Bundle">${options(bundleNames, bundle, "All bundles")}</select>
      <select name="belief" aria-label="Belief state">${choices(["current", "all", "historical"], belief)}</select>
      <select name="limit" aria-label="Result limit">${choices(["50", "100", "200"], limit)}</select>
      <details class="scope-controls"><summary>Scope filters</summary><div class="form-grid">${Object.entries(scope).map(([key, value]) => html`<label>${key.slice(6)}<input name="${key}" value="${value}" placeholder="Any"></label>`)}</div></details>
      <button type="submit">Search</button>
    </form>
    ${result.warnings?.length ? html`<details class="notice notice-warn"><summary>${result.warnings.length} search ${result.warnings.length === 1 ? "notice" : "notices"}</summary><ul>${result.warnings.map((w) => html`<li>${w}</li>`)}</ul></details>` : ""}
    ${
      result.hits.length === 0
        ? emptyState(q ? `No assets match "${q}".` : "No assets found.", result.tip ?? "")
        : html`<p class="muted">${result.hits.length} ${result.hits.length === 1 ? "result" : "results"}${result.hits.length === Number(limit) ? ` (first ${limit}; narrow the query or filters for more specific results)` : ""}, ${result.searchMode ?? "search"} mode${result.timing ? `, ${result.timing.totalMs} ms` : ""}.</p>${q ? html`<ul class="hits">${result.hits.map((h) => hit(h, returnTo))}</ul>` : html`<div class="asset-inventory">${[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, hits]) => html`<details open><summary>${name} <span class="muted">(${hits.length})</span></summary><ul class="hits">${hits.sort((a, b) => a.ref.localeCompare(b.ref)).map((h) => hit(h, returnTo))}</ul></details>`)}</div>`}`
    }`;
}
