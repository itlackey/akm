// Search: query box with type and bundle filters; results link to the asset view.

import { api, assetHref, badge, emptyState, html, pageHeader } from "./lib.js";

const RESULT_LIMIT = 50;

function options(values, selected, allLabel) {
  return html`<option value="">${allLabel}</option>${values.map((v) => html`<option value="${v}" ${v === selected ? html`selected` : ""}>${v}</option>`)}`;
}

function hit(h) {
  return html`<li class="hit">
    <div class="hit-head"><a class="mono wrap" href="${assetHref(h.ref)}">${h.ref}</a>${badge(h.type, "info")}${h.origin ? html`<span class="muted small">${h.origin}</span>` : ""}${typeof h.score === "number" ? html`<span class="num muted small" title="Ranking score">score ${h.score.toFixed(3)}</span>` : ""}</div>
    ${h.description ? html`<p>${h.description}</p>` : ""}
    ${Array.isArray(h.tags) && h.tags.length > 0 ? html`<div class="tags">${h.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : ""}
    ${Array.isArray(h.whyMatched) && h.whyMatched.length > 0 ? html`<p class="muted small">Matched: ${h.whyMatched.join(", ")}</p>` : ""}
  </li>`;
}

export async function render(ctx) {
  const q = ctx.query.get("q") ?? "";
  const type = ctx.query.get("type") ?? "";
  const bundle = ctx.query.get("bundle") ?? "";
  const [result, bundles] = await Promise.all([
    api("/api/search", { q, type, bundle, limit: RESULT_LIMIT }),
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

  return html`${pageHeader("Search", "Search your bundles. Browsing here is not counted as usage.")}
    <form class="search-form" role="search">
      <input type="search" name="q" value="${q}" placeholder="Search assets (empty lists everything)" aria-label="Query" autofocus>
      <select name="type" aria-label="Type">${options([...types].sort(), type, "All types")}</select>
      <select name="bundle" aria-label="Bundle">${options(bundleNames, bundle, "All bundles")}</select>
      <button type="submit">Search</button>
    </form>
    ${(result.warnings ?? []).map((w) => html`<div class="notice notice-warn">${w}</div>`)}
    ${
      result.hits.length === 0
        ? emptyState(q ? `No assets match "${q}".` : "No assets found.", result.tip ?? "")
        : html`<p class="muted">${result.hits.length} ${result.hits.length === 1 ? "result" : "results"}${result.hits.length === RESULT_LIMIT ? ` (the first ${RESULT_LIMIT})` : ""}, ${result.searchMode ?? "search"} mode${result.timing ? `, ${result.timing.totalMs} ms` : ""}.</p><ul class="hits">${result.hits.map(hit)}</ul>`
    }`;
}
