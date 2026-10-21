// Asset view: metadata, frontmatter table, the body as safe markdown, links and feedback.

import { diffSection } from "./diff-view.js";
import {
  actionForm,
  api,
  assetHref,
  badge,
  definitionList,
  emptyState,
  html,
  pageHeader,
  post,
  tableWrap,
  when,
} from "./lib.js";
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

function feedbackBlock(feedback, ref, requireReason) {
  const counts = feedback?.counts ?? { positive: 0, negative: 0 };
  const history = feedback?.history ?? [];
  return html`<section><h2>Feedback</h2>
    <p><span class="num big text-ok">${counts.positive ?? 0}</span> <span class="muted">positive</span> &nbsp; <span class="num big text-fail">${counts.negative ?? 0}</span> <span class="muted">negative</span></p>
    ${
      ref
        ? html`<form class="feedback-form form-grid">
      <label>Feedback <select name="signal"><option value="positive">Helpful</option><option value="negative">Incorrect or stale</option></select></label>
      <label>Reason <textarea name="reason" rows="2" placeholder="What helped, or what is wrong and should change"></textarea></label>
      <p class="muted small">${requireReason ? "A reason is required for negative feedback. " : ""}A note that did not fit your task is not necessarily incorrect.</p>
      <label>Tags <input name="tags" placeholder="Optional key:value tags, comma-separated (team:platform)"></label>
      <button type="submit">Send feedback</button><div data-status></div>
    </form>`
        : ""
    }
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
  const canonical = data.durableRef ?? asset.ref;
  const headings = (data.headings ?? []).filter((h) => h.slug);
  const historyOpen = ctx.query.get("history") === "1";
  let history = "";
  if (historyOpen) {
    const versions = await api("/api/asset/history", { ref: canonical, revision: ctx.query.get("revision") });
    const diff = versions.diff ? diffSection(versions.diff) : null;
    if (diff?.wire) ctx.after.push(diff.wire);
    history = html`<section><h2>Document history</h2>${
      !versions.available
        ? emptyState("No Git history is available for this bundle.")
        : html`
      ${versions.commits.length === 0 ? emptyState("No committed version of this file.") : html`<ul>${versions.commits.map((c) => html`<li><a href="${assetHref(canonical)}&history=1&revision=${c.sha}">${c.shortSha}</a> ${c.subject} <span class="muted">${when(c.time)} · ${c.author}</span></li>`)}</ul>`}
      ${diff?.markup ?? ""}`
    }</section>`;
  }
  ctx.after.push((root) => {
    actionForm(root, ".feedback-form", (_form, values) =>
      post("/api/feedback", {
        ref: canonical,
        signal: values.get("signal"),
        reason: values.get("reason"),
        tags: String(values.get("tags") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    );
    const signal = root.querySelector('[name="signal"]');
    const reason = root.querySelector('[name="reason"]');
    signal?.addEventListener("change", () => {
      reason.required = data.feedbackRequireReason && signal.value === "negative";
    });
    const section = ctx.query.get("section");
    if (section) requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView());
  });
  return html`${back}${pageHeader(html`<span class="mono wrap">${asset.ref}</span>`)}
    <p class="action-links"><a href="${assetHref(canonical)}&history=1">Document history</a> · <a href="#/new">New knowledge</a>${asset.editable && ["knowledge", "memory"].includes(asset.type) ? html` · <a href="#/edit?ref=${encodeURIComponent(canonical)}">Edit Markdown</a>` : ""}</p>
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
    ${headings.length > 1 ? html`<details class="contents" open><summary>On this page</summary><ul>${headings.map((h) => html`<li><a href="${assetHref(canonical)}&section=${encodeURIComponent(h.slug)}">${h.text}</a></li>`)}</ul></details>` : ""}
    <section><h2>Content</h2>${body.trim() === "" ? emptyState("This asset has no body.") : markdown(body, { ref: canonical, bundle: data.bundle, links: data.links, headings: data.headings })}</section>
    <details><summary>Markdown source</summary><pre class="code">${asset.content ?? ""}</pre></details>
    ${history}
    ${linksBlock(asset.links)}
    ${feedbackBlock(data.feedback, data.durableRef, data.feedbackRequireReason)}`;
}
