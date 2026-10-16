// Proposals: the pending queue grouped by source, recent decisions, and a detail view with the diff.

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

function listHref(status, source) {
  const params = new URLSearchParams();
  if (status !== "pending") params.set("status", status);
  if (source) params.set("source", source);
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

function refCell(p) {
  return html`<a class="mono wrap" href="${proposalHref(p.id)}">${p.ref}</a>${p.isRetire && p.retirement ? html`<div class="small muted">retires in favour of <span class="mono">${p.retirement.successorRef}</span></div>` : ""}`;
}

function sourceChips(counts, active, status) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (label, source, n) =>
    html`<a class="chip ${(active ?? "") === source ? "active" : ""}" href="${listHref(status, source)}" ${(active ?? "") === source ? html`aria-current="true"` : ""}>${label} <span class="num">${n}</span></a>`;
  return html`<div class="chips">${chip("All", "", total)}${Object.entries(counts)
    .sort()
    .map(([s, n]) => chip(s, s, n))}</div>`;
}

function pendingView(data, source) {
  const shown = data.proposals.filter((p) => !source || p.source === source);
  if (data.totalCount === 0)
    return emptyState(
      "No pending proposals.",
      "The queue is empty. Proposals appear here when akm improve stages a change for review.",
    );
  const groups = new Map();
  for (const p of shown) groups.set(p.source, [...(groups.get(p.source) ?? []), p]);
  return html`${sourceChips(data.bySource, source, "pending")}
    ${data.totalCount > data.proposals.length ? html`<p class="muted">Showing the first ${data.proposals.length} of ${data.totalCount}.</p>` : ""}
    ${
      shown.length === 0
        ? emptyState("Nothing pending from this source.")
        : [...groups].map(
            ([name, items]) =>
              html`<section data-group="${name}"><h2>${name} <span class="muted num">${items.length}</span></h2>
                <label class="select-group"><input type="checkbox" data-select-group> select all in this group</label>${tableWrap(
                  html`<table><thead><tr><th class="select"><span class="sr-only">Select</span></th><th>Asset</th><th>Waiting</th><th>Gate decision</th><th class="r">Confidence</th></tr></thead><tbody>${items.map(
                    (p) =>
                      html`<tr>${selectCell(p)}<td>${refCell(p)}</td><td>${when(p.waitingSince)}</td><td>${gate(p.gateDecision)}</td><td class="r num">${typeof p.confidence === "number" ? p.confidence.toFixed(2) : "-"}</td></tr>`,
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

function recentView(data, source) {
  const counts = {};
  for (const p of data.proposals) counts[p.source] = (counts[p.source] ?? 0) + 1;
  const shown = data.proposals.filter((p) => !source || p.source === source);
  if (data.totalCount === 0)
    return emptyState("No decided proposals yet.", "Accepted, rejected and reverted proposals are listed here.");
  return html`${sourceChips(counts, source, "recent")}
    ${
      shown.length === 0
        ? emptyState("Nothing decided from this source.")
        : tableWrap(
            html`<table><thead><tr><th>Decided</th><th>Outcome</th><th>Source</th><th>Asset</th><th>Reason</th></tr></thead><tbody>${shown.map(
              (p) =>
                html`<tr><td>${when(p.review?.decidedAt ?? p.updatedAt)}</td><td>${outcomeBadge(p.status)}</td><td class="mono">${p.source}</td><td>${refCell(p)}</td><td class="wrap">${p.review?.reason ?? p.gateDecision?.reason ?? html`<span class="muted">-</span>`}</td></tr>`,
            )}</tbody></table>`,
          )
    }`;
}

const PENDING_LIMIT = 200;

export async function renderList(ctx) {
  const status = ctx.query.get("status") === "recent" ? "recent" : "pending";
  const source = ctx.query.get("source") ?? "";
  const data = await api("/api/proposals", { status, limit: PENDING_LIMIT });
  const tab = (name, label) =>
    html`<a class="tab ${status === name ? "active" : ""}" href="${listHref(name, "")}" ${status === name ? html`aria-current="page"` : ""}>${label}</a>`;
  const head = html`${pageHeader("Proposals", "Changes akm improve has staged for review.")}
    <nav class="tabs" aria-label="Proposal lists">${tab("pending", "Pending")}${tab("recent", "Recent")}</nav>`;
  if (status === "recent") return html`${head}${recentView(data, source)}`;
  ctx.after.push((root) =>
    wireBatch(root, {
      reload: async () => pendingView(await api("/api/proposals", { status: "pending", limit: PENDING_LIMIT }), source),
    }),
  );
  return html`${head}<div data-proposal-list><div data-list>${pendingView(data, source)}</div><div class="batch-bar" data-batch-bar hidden></div></div>`;
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
async function nextPendingId(id) {
  try {
    const { proposals } = await api("/api/proposals", { status: "pending", limit: PENDING_LIMIT });
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
  const nextId = pending ? await nextPendingId(p.id) : null;
  const diff = data.diff ? diffSection(data.diff) : null;
  if (diff?.wire) ctx.after.push((root) => diff.wire(root));
  if (pending) {
    ctx.after.push((root) =>
      wireDetailActions(root, {
        id: p.id,
        nextId,
        onDecided: (status) => {
          const target = root.querySelector("[data-status]");
          if (target) mount(target, statusBadges(p, status));
        },
      }),
    );
  }
  return html`<p class="crumbs"><a href="#/proposals">Proposals</a> / <span class="mono">${p.id.slice(0, 8)}</span></p>
    ${pageHeader(html`<span class="mono wrap">${p.ref}</span>`)}
    <div class="badges" data-status>${statusBadges(p, p.status)}</div>
    ${pending ? detailActions(nextId) : ""}
    <section><div class="card">${definitionList([
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
    ])}</div></section>
    ${p.retirement ? retirementBlock(p.retirement) : ""}
    ${findings.length > 0 ? html`<section><h2>Validation</h2><ul class="plain">${findings.map((f) => html`<li>${badge(f.severity ?? "info", f.severity === "error" ? "fail" : "warn")} <span class="mono small">${f.kind}</span> ${f.message}</li>`)}</ul></section>` : ""}
    <section><h2>Diff</h2>${
      diff
        ? html`<p class="muted small">${data.diff.isNew ? "New asset. " : ""}Target <span class="mono wrap">${data.diff.targetPath ?? ""}</span></p>${diff.markup}`
        : emptyState("No diff available.", data.diffError ?? "")
    }</section>
    <p><a href="${assetHref(p.ref)}">View the asset as it is now</a></p>`;
}
