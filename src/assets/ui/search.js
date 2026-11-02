// Search: query box with type and bundle filters; results link to the asset view.

import { ago, api, assetHref, badge, emptyState, fmtNum, html, pageHeader, tableWrap, wireFilterForm } from "./lib.js";

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
  </li>`;
}

/** The three views of Search, as tabs that keep the query in the address. */
function tabs(active, q) {
  const link = (name, label, extra = "") => {
    const params = new URLSearchParams();
    if (name !== "browse" && name !== "misses" && q) params.set("q", q);
    if (name !== "results") params.set("tab", name);
    return html`<a class="tab" href="#/search${params.size ? `?${params}` : ""}" ${active === name ? html`aria-current="page"` : ""}>${label}${extra}</a>`;
  };
  return html`<nav class="tabs" aria-label="Search views">${link("results", "Results")}${link("browse", "Browse")}${link("misses", "Misses")}</nav>`;
}

async function renderMisses(ctx) {
  const data = await api("/api/search/misses", { since: "30d" });
  const repeated = data.misses.filter((m) => m.repeated);
  ctx.announcement = `Search misses. ${data.misses.length} ${data.misses.length === 1 ? "query" : "queries"} found nothing in the last 30 days.`;
  const write = (query) => html`<a href="#/new?q=${encodeURIComponent(query)}">Write this up</a>`;
  return html`${pageHeader("Search", "Search or browse your indexed assets, and see what akm could not find.")}
    ${tabs("misses", "")}
    <p class="queue-sentence"><strong class="num">${fmtNum(data.foundNothing)}</strong> of ${fmtNum(data.searches)} searches found nothing in the last 30 days${repeated.length ? html`; <strong class="num">${repeated.length}</strong> ${repeated.length === 1 ? "query" : "queries"} came up on two or more days` : ""}.</p>
    <p class="muted small">Your own searches only. A query that missed on several days is a gap in the library, not a typo: write it up.</p>
    ${
      data.misses.length === 0
        ? emptyState(
            "No search found nothing in this window.",
            "Searches from you and your agents appear here when they come back empty.",
          )
        : tableWrap(
            html`<table><thead><tr><th>Query</th><th class="r">Times</th><th class="r">Days</th><th>Last seen</th><th>Next step</th></tr></thead><tbody>${data.misses.map((m) => html`<tr><th class="wrap">${m.query}${m.repeated ? html` ${badge("repeated", "warn")}` : ""}</th><td class="r num">${fmtNum(m.count)}</td><td class="r num">${fmtNum(m.days)}</td><td>${ago(m.lastAt)}</td><td>${write(m.query)}</td></tr>`)}</tbody></table>`,
          )
    }`;
}

export async function render(ctx) {
  if (ctx.query.get("tab") === "misses") return renderMisses(ctx);
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
  // Filters off their defaults, named in the closed summary so a narrowed search never looks like a full one.
  const active = [
    type && `type ${type}`,
    bundle && `bundle ${bundle}`,
    belief !== "current" && `belief ${belief}`,
    limit !== String(RESULT_LIMIT) && `${limit} results`,
    ...Object.entries(scope)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key.slice(6)} ${value}`),
  ].filter(Boolean);

  ctx.after.push((root) => wireFilterForm(root.querySelector("form.search-form"), "search"));

  const groups = new Map();
  for (const h of result.hits) {
    const group = h.ref.slice(0, h.ref.lastIndexOf("/")) || h.type;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(h);
  }
  ctx.announcement = `Search. ${result.hits.length === 0 ? "No results" : `${result.hits.length} ${result.hits.length === 1 ? "result" : "results"}`}${q ? ` for ${q}` : ""}.`;
  return html`${pageHeader("Search", "Search or browse your indexed assets. Browsing is not counted as usage.")}
    ${tabs(q ? "results" : "browse", q)}
    <form class="search-form" role="search">
      <input type="search" name="q" value="${q}" placeholder="Search assets (empty browses the index)" aria-label="Query" autofocus>
      <button type="submit">Search</button>
      <details class="search-filters" ${active.length ? html`open` : ""}><summary>Filters${active.length ? html`<span class="muted small">: ${active.join(" · ")}</span>` : ""}</summary><div class="form-grid">
        <label>Type<select name="type">${options([...types].sort(), type, "All types")}</select></label>
        <label>Bundle<select name="bundle">${options(bundleNames, bundle, "All bundles")}</select></label>
        <label>Belief state<select name="belief">${choices(["current", "all", "historical"], belief)}</select></label>
        <label>Results<select name="limit">${choices(["50", "100", "200"], limit)}</select></label>
        ${Object.entries(scope).map(([key, value]) => html`<label>${key.slice(6)}<input name="${key}" value="${value}" placeholder="Any"></label>`)}
      </div></details>
    </form>
    ${result.warnings?.length ? html`<details class="notice notice-warn"><summary>${result.warnings.length} search ${result.warnings.length === 1 ? "notice" : "notices"}</summary><ul>${result.warnings.map((w) => html`<li>${w}</li>`)}</ul></details>` : ""}
    ${
      result.hits.length === 0
        ? emptyState(
            q ? `No assets match "${q}".` : "No assets found.",
            q
              ? html`${result.tip ?? ""} <a href="#/new?q=${encodeURIComponent(q)}">Write this up</a> · <a href="#/search?tab=misses">See what else found nothing</a>`
              : (result.tip ?? ""),
          )
        : html`<p class="muted">${result.hits.length} ${result.hits.length === 1 ? "result" : "results"}${result.hits.length === Number(limit) ? ` (first ${limit}; narrow the query or filters for more specific results)` : ""}, ${result.searchMode ?? "search"} mode${result.timing ? `, ${result.timing.totalMs} ms` : ""}.</p>${q ? html`<ul class="hits">${result.hits.map((h) => hit(h, returnTo))}</ul>` : html`<div class="asset-inventory">${[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, hits]) => html`<details open><summary>${name} <span class="muted">(${hits.length})</span></summary><ul class="hits">${hits.sort((a, b) => a.ref.localeCompare(b.ref)).map((h) => hit(h, returnTo))}</ul></details>`)}</div>`}`
    }`;
}
