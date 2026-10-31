// Proposals: the pending queue grouped by source, recent decisions, and a detail view with the diff.

import { horizontalBars, wireChart } from "./chart-view.js";
import { diffSection } from "./diff-view.js";
import {
  api,
  assetHref,
  badge,
  definitionList,
  emptyState,
  fmtDateTime,
  html,
  mount,
  pageHeader,
  pretty,
  proposalHref,
  tableWrap,
  when,
} from "./lib.js";
import { detailActions, wireBatch, wireDetailActions } from "./proposal-actions.js";

function listHref(status, source, age = "") {
  const params = new URLSearchParams();
  if (status !== "pending") params.set("status", status);
  if (source) params.set("source", source);
  if (age) params.set("age", age);
  const q = params.toString();
  return `#/proposals${q ? `?${q}` : ""}`;
}

function gate(decision) {
  if (!decision) return html`<span class="muted">-</span>`;
  const kind = decision.outcome === "auto-rejected" ? "fail" : decision.outcome === "deferred" ? "warn" : "info";
  return html`${badge(decision.outcome, kind)}${decision.reason ? html` <span class="muted small">${decision.reason}</span>` : ""}`;
}

function selectCell(p) {
  return html`<td class="select"><input type="checkbox" data-select value="${p.id}" data-ref="${p.ref}" aria-label="Select ${p.ref}"></td>`;
}

function refCell(p, query) {
  return html`<a class="mono wrap" href="${proposalHref(p.id, query)}">${p.ref}</a>${p.isRetire && p.retirement ? html`<div class="small muted">retires in favour of <span class="mono">${p.retirement.successorRef}</span></div>` : ""}`;
}

function sourceChips(counts, active, status, age = "") {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (label, source, n) =>
    html`<a class="chip ${(active ?? "") === source ? "active" : ""}" href="${listHref(status, source, age)}" ${(active ?? "") === source ? html`aria-current="true"` : ""}>${label} <span class="num">${n}</span></a>`;
  return html`<div class="chips">${chip("All", "", total)}${Object.entries(counts)
    .sort()
    .map(([s, n]) => chip(s, s, n))}</div>`;
}

function pendingView(data, source, query = "") {
  const shown = data.proposals.filter((p) => !source || p.source === source);
  if (data.fullCount === 0)
    return emptyState(
      "No pending proposals.",
      "The queue is empty. Proposals appear here when akm improve stages a change for review.",
    );
  const groups = new Map();
  for (const p of shown) groups.set(p.source, [...(groups.get(p.source) ?? []), p]);
  return html`${sourceChips(data.bySource, source, "pending", new URLSearchParams(query).get("age"))}
    ${data.totalCount > data.proposals.length ? html`<p class="muted">Showing the first ${data.proposals.length} of ${data.totalCount}.</p>` : ""}
    ${
      shown.length === 0
        ? emptyState("No proposals in this queue.", html`<a href="#/proposals">View all proposals</a>`)
        : [...groups].map(
            ([name, items]) =>
              html`<section data-group="${name}"><h2>${name} <span class="muted num">${items.length}</span></h2>
                <label class="select-group"><input type="checkbox" data-select-group> select all in this group</label>${tableWrap(
                  html`<table><thead><tr><th class="select"><span class="sr-only">Select</span></th><th>Asset</th><th>Waiting</th><th>Gate decision</th><th class="r">Confidence</th></tr></thead><tbody>${items.map(
                    (p) =>
                      html`<tr>${selectCell(p)}<td>${refCell(p, query)}</td><td>${when(p.waitingSince)}</td><td>${gate(p.gateDecision)}</td><td class="r num">${typeof p.confidence === "number" ? p.confidence.toFixed(2) : "-"}</td></tr>`,
                  )}</tbody></table>`,
                )}</section>`,
          )
    }`;
}

function outcomeBadge(status) {
  return badge(
    status,
    status === "accepted" ? "ok" : status === "rejected" ? "fail" : status === "pending" ? "info" : "warn",
  );
}

function recentView(data, source, query) {
  const shown = data.proposals.filter((p) => !source || p.source === source);
  if (data.fullCount === 0)
    return emptyState("No decided proposals yet.", "Accepted, rejected and reverted proposals are listed here.");
  return html`${sourceChips(data.bySource, source, "recent")}
    ${data.totalCount > data.proposals.length ? html`<p class="muted">Showing the first ${data.proposals.length} of ${data.totalCount}.</p>` : ""}
    ${
      shown.length === 0
        ? emptyState("Nothing decided from this source.")
        : tableWrap(
            html`<table><thead><tr><th>Decided</th><th>Outcome</th><th>Source</th><th>Asset</th><th>Reason</th></tr></thead><tbody>${shown.map(
              (p) =>
                html`<tr><td>${when(p.review?.decidedAt ?? p.updatedAt)}</td><td>${outcomeBadge(p.status)}</td><td class="mono">${p.source}</td><td>${refCell(p, query)}</td><td class="wrap">${p.review?.reason ?? p.gateDecision?.reason ?? html`<span class="muted">-</span>`}</td></tr>`,
            )}</tbody></table>`,
          )
    }`;
}

const PENDING_LIMIT = 200;
const AGE_BANDS = { underDay: "Under 1 day", underWeek: "1–7 days", older: "7+ days", unknown: "Unknown age" };

function backlogTable(rows) {
  return tableWrap(
    html`<table><thead><tr><th>Source</th>${Object.values(AGE_BANDS).map((label) => html`<th>${label}</th>`)}</tr></thead><tbody>${rows.map((row) => html`<tr><th>${row.source}</th>${Object.keys(AGE_BANDS).map((key) => html`<td><a href="${listHref("pending", row.source, key)}">${row[key]}</a></td>`)}</tr>`)}</tbody></table>`,
  );
}

function backlog(ctx, data) {
  wireChart(
    ctx,
    "#backlog-chart",
    () =>
      horizontalBars(
        data.backlog.map((row) => row.source),
        Object.entries(AGE_BANDS).map(([key, name]) => ({
          name,
          stack: "waiting",
          data: data.backlog.map((row) => row[key]),
        })),
        "Pending",
      ),
    (event) => {
      const source = data.backlog[event.dataIndex]?.source;
      const age = Object.keys(AGE_BANDS)[event.seriesIndex];
      if (source && age) location.hash = listHref("pending", source, age);
    },
  );
  return html`<section class="chart-card"><h2>Waiting for review</h2><p class="muted small">All <span data-backlog-total>${data.fullCount}</span> pending proposals. Age starts at the last reopening, or creation.</p><p class="chart-legend">${Object.values(AGE_BANDS).map((label, index) => html`<span><i class="series-key series-${index + 1}" aria-hidden="true"></i>${label}</span>`)}</p>${data.backlog.length ? html`<div class="echarts-view" id="backlog-chart" role="img" aria-label="Pending proposals by source and waiting age. Select a segment or a table link to review that queue."></div>` : ""}<details><summary>Queue counts and filters</summary><div data-backlog-table>${backlogTable(data.backlog)}</div></details></section>`;
}

export async function renderList(ctx) {
  const status = ctx.query.get("status") === "recent" ? "recent" : "pending";
  const source = ctx.query.get("source") ?? "";
  const age = ctx.query.get("age") ?? "";
  const query = String(ctx.query);
  const data = await api("/api/proposals", { status, source, age, limit: PENDING_LIMIT });
  const tab = (name, label) =>
    html`<a class="tab ${status === name ? "active" : ""}" href="${listHref(name, "")}" ${status === name ? html`aria-current="page"` : ""}>${label}</a>`;
  const head = html`${pageHeader("Proposals", "Changes akm improve has staged for review.")}
    <nav class="tabs" aria-label="Proposal lists">${tab("pending", "Pending")}${tab("recent", "Recent")}</nav>`;
  if (status === "recent") return html`${head}${recentView(data, source, query)}`;
  ctx.after.push((root) =>
    wireBatch(root, {
      reload: async () => {
        const fresh = await api("/api/proposals", { status: "pending", source, age, limit: PENDING_LIMIT });
        data.backlog = fresh.backlog;
        const total = root.querySelector("[data-backlog-total]");
        if (total) total.textContent = fresh.fullCount;
        const table = root.querySelector("[data-backlog-table]");
        if (table) mount(table, backlogTable(data.backlog));
        root.dispatchEvent(new Event("change"));
        return pendingView(fresh, source, query);
      },
    }),
  );
  return html`${head}${backlog(ctx, data)}${age ? html`<p>Waiting age: ${AGE_BANDS[age] ?? age} · <a href="${listHref("pending", source)}">Clear age filter</a></p>` : ""}<div data-proposal-list><div data-list>${pendingView(data, source, query)}</div><div class="batch-bar" data-batch-bar hidden></div></div>`;
}

// ---- detail ----------------------------------------------------------------

function retirementBlock(r) {
  const list = (items) =>
    items && items.length > 0
      ? html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`
      : html`<span class="muted">nothing</span>`;
  return html`<section><h2>Retirement</h2><div class="card">${definitionList([
    ["Retires", html`<a class="mono wrap" href="${assetHref(r.retiredRef)}">${r.retiredRef}</a>`],
    ["Successor", html`<a class="mono wrap" href="${assetHref(r.successorRef)}">${r.successorRef}</a>`],
    ["Reason", r.reason],
    ["Judge", html`${badge(r.judgeLabel, "info")} ${r.judgeReason}`],
    ["Similarity", typeof r.cosine === "number" ? html`<span class="num">${r.cosine.toFixed(2)}</span> cosine` : ""],
    ["Only in retired", list(r.onlyInRetired)],
    ["Only in successor", list(r.onlyInSuccessor)],
    [
      "Continuity risk",
      r.continuityRisk
        ? html`${badge("flagged", "warn")} <pre class="code">${pretty(r.continuityRisk)}</pre>`
        : html`<span class="muted">none flagged</span>`,
    ],
  ])}</div></section>`;
}

function statusBadges(p, status) {
  return html`${outcomeBadge(status)}${badge(p.source, "info")}${p.isRetire ? badge("retire", "warn") : ""}`;
}

/** The pending proposal after `id` in the pending list's order (else the first other one); `null` when none is waiting. */
async function nextPendingId(id, query) {
  try {
    const { proposals } = await api("/api/proposals", {
      status: "pending",
      source: query.get("source"),
      age: query.get("age"),
      limit: PENDING_LIMIT,
    });
    const at = proposals.findIndex((p) => p.id === id);
    return (proposals[at + 1] ?? proposals.find((p) => p.id !== id))?.id ?? null;
  } catch {
    return null;
  }
}

export async function renderDetail(ctx) {
  const data = await api(`/api/proposals/${encodeURIComponent(ctx.param)}`);
  const p = data.proposal;
  const findings = data.validation?.findings ?? [];
  const pending = p.status === "pending";
  const nextId = pending ? await nextPendingId(p.id, ctx.query) : null;
  const query = String(ctx.query);
  const diff = data.diff ? diffSection(data.diff) : null;
  if (diff?.wire) ctx.after.push((root) => diff.wire(root));
  if (pending) {
    ctx.after.push((root) =>
      wireDetailActions(root, {
        id: p.id,
        nextId,
        query,
        onDecided: (status) => {
          const target = root.querySelector("[data-status]");
          if (target) mount(target, statusBadges(p, status));
        },
      }),
    );
  }
  return html`<p class="crumbs"><a href="#/proposals${query ? `?${query}` : ""}">Back to queue${ctx.query.get("source") ? `: ${ctx.query.get("source")}` : ""}</a> / <span class="mono">${p.id.slice(0, 8)}</span></p>
    ${pageHeader(html`<span class="mono wrap">${p.ref}</span>`)}
    <div class="badges" data-status>${statusBadges(p, p.status)}</div>
    ${p.retirement ? retirementBlock(p.retirement) : ""}
    ${findings.length > 0 ? html`<section><h2>Validation</h2><ul class="plain">${findings.map((f) => html`<li>${badge(f.severity ?? "info", f.severity === "error" ? "fail" : "warn")} <span class="mono small">${f.kind}</span> ${f.message}</li>`)}</ul></section>` : ""}
    <section><h2>Proposed change</h2>${diff ? html`<p class="muted small">${data.diff.isNew ? "New asset. " : ""}Target <span class="mono wrap">${data.diff.targetPath ?? p.proposedTarget?.root ?? ""}</span></p>${diff.markup}` : emptyState("No diff available.", data.diffError ?? "")}</section>
    ${pending ? detailActions(nextId, query) : ""}
    <details><summary>Proposal details</summary>${definitionList([
      ["Id", html`<span class="mono">${p.id}</span>`],
      ["Created", html`${when(p.createdAt)} <span class="muted small">${fmtDateTime(p.createdAt)}</span>`],
      ["Waiting since", when(p.waitingSince)],
      ["Confidence", typeof p.confidence === "number" ? p.confidence.toFixed(2) : ""],
      ["Source run", p.sourceRun ? html`<span class="mono">${p.sourceRun}</span>` : ""],
      [
        "Target",
        p.proposedTarget
          ? html`<span class="mono wrap">${p.proposedTarget.root}</span> <span class="muted">(${p.proposedTarget.source})</span>`
          : "",
      ],
      ["Gate decision", p.gateDecision ? gate(p.gateDecision) : ""],
      [
        "Review",
        p.review ? html`${outcomeBadge(p.review.outcome)} ${p.review.reason ?? ""} ${when(p.review.decidedAt)}` : "",
      ],
      [
        "Changes",
        p.changes?.length > 0
          ? html`<ul class="plain">${p.changes.map((c) => html`<li>${badge(c.op, "neutral")} <span class="mono wrap">${c.path}</span></li>`)}</ul>`
          : "",
      ],
    ])}</details>
    <p><a href="${assetHref(p.ref)}">View the asset as it is now</a></p>`;
}
