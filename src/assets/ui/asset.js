// Asset view: metadata, frontmatter table, the body as safe markdown, links and feedback.

import { sparkline } from "./charts.js";
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
  proposalHref,
  searchReturn,
  tableWrap,
  when,
} from "./lib.js";
import { headingId, markdown, splitFrontmatter } from "./markdown.js";

/** The rail: what this asset is, and what improve and feedback have done to it. */
function rail(asset, data, improve, bundle) {
  const pending = (improve?.proposals ?? []).filter((p) => p.status === "pending");
  const feedback = (improve?.usageByWeek ?? []).reduce(
    (sum, w) => ({ positive: sum.positive + w.positive, negative: sum.negative + w.negative }),
    { positive: 0, negative: 0 },
  );
  const decided = (improve?.proposals ?? []).filter((p) => p.status !== "pending").slice(0, 5);
  const spark = sparkline(
    (improve?.usageByWeek ?? []).map((w) => w.hits),
    "Weekly finds and opens, last 90 days",
  );
  return html`<aside class="asset-rail" aria-label="About this asset">
    ${definitionList([
      ["Type", asset.type],
      ["Bundle", bundle ?? ""],
      [
        "Feedback",
        html`<span class="num"><span class="text-ok">+${feedback.positive}</span> / <span class="text-fail">−${feedback.negative}</span></span> <span class="muted small">90 days</span>`,
      ],
    ])}
    ${pending.length ? html`<p class="notice notice-warn">${pending.length} pending ${pending.length === 1 ? "proposal" : "proposals"} <a href="${proposalHref(pending[0].id)}">Review →</a></p>` : ""}
    <h2 class="rail-title">Improve history</h2>
    ${
      improve === null
        ? html`<p class="muted small">Unavailable.</p>`
        : html`${spark}<p class="muted small">Finds and opens per week, last 90 days.</p>
          ${decided.length ? html`<ul class="plain">${decided.map((p) => html`<li>${badge(p.outcome, p.outcome === "reverted" ? "warn" : "neutral")} <span class="mono small">${p.source}</span> <a class="small" href="${proposalHref(p.id)}">${when(p.decidedAt)}</a></li>`)}</ul>` : html`<p class="muted small">No proposals decided for this asset.</p>`}`
    }
  </aside>`;
}

function fixForm() {
  return html`<details class="fix"><summary>Suggest a fix</summary>
    <form class="fix-form form-grid">
      <label>Replace this exact text <textarea name="replace" rows="2" required></textarea></label>
      <label>With <textarea name="with" rows="2" required></textarea></label>
      <label>Why <input name="reason" required placeholder="What is wrong with the current text"></label>
      <label>Source <input name="source" placeholder="Optional: a URL, command or file that shows it"></label>
      <p class="muted small">akm checks that the text appears exactly once before it records the fix.</p>
      <button type="submit">Send suggested fix</button><div data-status></div>
    </form></details>`;
}

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
  const ref = ctx.query.get("ref") || ctx.param || "";
  if (!ref)
    return html`${pageHeader("Asset")}${emptyState("No asset selected.", html`Pick one from <a href="#/search">search</a>.`)}`;
  const data = await api("/api/asset", { ref });
  const improve = data.redacted
    ? null
    : await api("/api/asset/improve", { ref: data.durableRef ?? ref }).catch(() => null);
  const returnTo = searchReturn(ctx.query);
  const back = html`<p class="crumbs"><a href="${returnTo || "#/search"}">${returnTo ? "Back to results" : "Search"}</a> / asset</p>`;
  if (data.redacted) {
    return html`${back}${pageHeader(html`<span class="mono wrap">${data.ref}</span>`)}<div class="badges">${badge(data.type, "info")}${badge("redacted", "warn")}</div>
      <div class="notice">${data.note}</div>`;
  }
  const asset = data.asset;
  // Commands carry their body as `template` and prompts as `prompt`; other types as `content`.
  const source = asset.content || asset.template || asset.prompt || "";
  const { fields, body, startLine } = splitFrontmatter(source);
  const canonical = data.durableRef ?? asset.ref;
  const href = assetHref(canonical, returnTo);
  const frontmatterTitle = fields.find(([key]) => key === "title")?.[1];
  const bodyTitle = body.match(/^#\s+(.+)$/m)?.[1];
  const title = frontmatterTitle || bodyTitle || asset.name;
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
      ${versions.commits.length === 0 ? emptyState("No committed version of this file.") : html`<ul>${versions.commits.map((c) => html`<li><a href="${href}&history=1&revision=${c.sha}">${c.shortSha}</a> ${c.subject} <span class="muted">${when(c.time)} · ${c.author}</span></li>`)}</ul>`}
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
    actionForm(root, ".fix-form", (_form, values) =>
      post("/api/feedback", {
        ref: canonical,
        signal: "negative",
        reason: values.get("reason"),
        replace: [String(values.get("replace") ?? "")],
        with: [String(values.get("with") ?? "")],
        source: values.get("source"),
      }),
    );
    root.querySelector("[data-copy-ref]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(canonical);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }
    });
    const signal = root.querySelector('[name="signal"]');
    const reason = root.querySelector('[name="reason"]');
    signal?.addEventListener("change", () => {
      reason.required = data.feedbackRequireReason && signal.value === "negative";
    });
    const section = ctx.query.get("section");
    // ?section= keeps the plain slug; the heading's element id is prefixed.
    if (section) requestAnimationFrame(() => document.getElementById(headingId(section))?.scrollIntoView());
  });
  return html`${back}${pageHeader(title)}
    <p class="action-links">${asset.editable && ["knowledge", "memory"].includes(asset.type) ? html`<a class="btn" href="#/edit?ref=${encodeURIComponent(canonical)}${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}">Edit Markdown</a> ` : ""}${data.durableRef ? html`<button type="button" class="btn-secondary" data-copy-ref>Copy ref</button> ` : ""}<a href="${href}&history=1">Document history</a></p>
    ${asset.editable && ["knowledge", "memory"].includes(asset.type) ? "" : data.durableRef ? fixForm() : ""}
    <div class="asset-layout"><div class="asset-main">
    <div class="badges">${badge(asset.type, "info")}${asset.origin ? badge(asset.origin, "neutral") : ""}${asset.editable ? badge("editable", "ok") : badge("read-only", "neutral")}</div>
    ${headings.length > 1 ? html`<details class="contents"><summary>On this page</summary><ul>${headings.map((h) => html`<li><a href="${href}&section=${encodeURIComponent(h.slug)}">${h.text}</a></li>`)}</ul></details>` : ""}
    <section class="document-body" aria-label="Content">${body.trim() === "" ? emptyState("This asset has no body.") : markdown(body, { ref: canonical, bundle: data.bundle, links: data.links, headings: data.headings, startLine, skipTitle: frontmatterTitle ? undefined : bodyTitle?.trim() })}</section>
    <details><summary>Asset details</summary>${definitionList([
      ["Name", html`<span class="mono">${asset.name}</span>`],
      [
        "Durable ref",
        data.durableRef
          ? html`<span class="mono wrap">${data.durableRef}</span>`
          : html`<span class="muted">not indexed</span>`,
      ],
      ["Path", html`<span class="mono wrap">${asset.path}</span>`],
    ])}
    ${fields.length > 0 ? html`<section><h2>Frontmatter</h2>${tableWrap(html`<table class="fm"><tbody>${fields.map(([k, v]) => html`<tr><th scope="row" class="mono">${k}</th><td class="mono wrap pre-wrap">${v}</td></tr>`)}</tbody></table>`)}</section>` : ""}
    </details>
    <details><summary>Markdown source</summary><pre class="code" tabindex="0" role="group" aria-label="Markdown source, scrolls sideways">${source}</pre></details>
    ${history}
    ${linksBlock(asset.links)}
    ${feedbackBlock(data.feedback, data.durableRef, data.feedbackRequireReason)}
    </div>${rail(asset, data, improve, data.bundle)}</div>`;
}
