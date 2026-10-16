// Asset view: metadata, frontmatter table, the body as safe markdown, links and feedback.

import { api, assetHref, badge, definitionList, emptyState, html, pageHeader, tableWrap, when } from "./lib.js";
import { markdown, splitFrontmatter } from "./markdown.js";

function linksBlock(links) {
  const groups = Object.entries(links ?? {}).filter(([, kinds]) => kinds && typeof kinds === "object");
  const rows = [];
  for (const [direction, kinds] of groups) {
    for (const [kind, info] of Object.entries(kinds)) {
      const refs = Array.isArray(info?.refs) ? info.refs : [];
      rows.push(
        html`<tr><td>${direction}</td><td>${kind}</td><td>${refs.map((r) => html`<a class="mono wrap" href="${assetHref(r)}">${r}</a> `)}${info?.total > refs.length ? html`<span class="muted">${info.total} total</span>` : ""}</td></tr>`,
      );
    }
  }
  if (rows.length === 0) return "";
  return html`<section><h2>Links</h2>${tableWrap(html`<table><thead><tr><th>Direction</th><th>Kind</th><th>Assets</th></tr></thead><tbody>${rows}</tbody></table>`)}</section>`;
}

function feedbackBlock(feedback) {
  const counts = feedback?.counts ?? { positive: 0, negative: 0 };
  const history = feedback?.history ?? [];
  return html`<section><h2>Feedback</h2>
    <p><span class="num big text-ok">${counts.positive ?? 0}</span> <span class="muted">positive</span> &nbsp; <span class="num big text-fail">${counts.negative ?? 0}</span> <span class="muted">negative</span></p>
    ${
      history.length === 0
        ? emptyState("No feedback recorded for this asset.")
        : tableWrap(
            html`<table><thead><tr><th>When</th><th>Signal</th><th>Source</th><th>Reason</th><th>Tags</th></tr></thead><tbody>${history.map(
              (e) =>
                html`<tr><td>${when(e.at)}</td><td>${badge(e.signal, e.signal === "positive" ? "ok" : "fail")}</td><td>${e.source}</td><td class="wrap">${e.reason ?? ""}</td><td class="mono small">${(e.tags ?? []).join(", ")}</td></tr>`,
            )}</tbody></table>`,
          )
    }
  </section>`;
}

export async function render(ctx) {
  const ref = ctx.query.get("ref") ?? "";
  if (!ref)
    return html`${pageHeader("Asset")}${emptyState("No asset selected.", html`Pick one from <a href="#/search">search</a>.`)}`;
  const data = await api("/api/asset", { ref });
  const back = html`<p class="crumbs"><a href="#/search">Search</a> / asset</p>`;
  if (data.redacted) {
    return html`${back}${pageHeader(html`<span class="mono wrap">${data.ref}</span>`)}<div class="badges">${badge(data.type, "info")}${badge("redacted", "warn")}</div>
      <div class="notice">${data.note}</div>`;
  }
  const asset = data.asset;
  const { fields, body } = splitFrontmatter(asset.content);
  return html`${back}${pageHeader(html`<span class="mono wrap">${asset.ref}</span>`)}
    <div class="badges">${badge(asset.type, "info")}${asset.origin ? badge(asset.origin, "neutral") : ""}${asset.editable ? badge("editable", "ok") : badge("read-only", "neutral")}</div>
    <section>${definitionList([
      ["Name", html`<span class="mono">${asset.name}</span>`],
      [
        "Durable ref",
        data.durableRef
          ? html`<span class="mono wrap">${data.durableRef}</span>`
          : html`<span class="muted">not indexed</span>`,
      ],
      ["Path", html`<span class="mono wrap">${asset.path}</span>`],
    ])}</section>
    ${fields.length > 0 ? html`<section><h2>Frontmatter</h2>${tableWrap(html`<table class="fm"><tbody>${fields.map(([k, v]) => html`<tr><th scope="row" class="mono">${k}</th><td class="mono wrap pre-wrap">${v}</td></tr>`)}</tbody></table>`)}</section>` : ""}
    <section><h2>Content</h2>${body.trim() === "" ? emptyState("This asset has no body.") : markdown(body)}</section>
    ${linksBlock(asset.links)}
    ${feedbackBlock(data.feedback)}`;
}
