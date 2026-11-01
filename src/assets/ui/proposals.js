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
import { detailActions, wireBatch, wireDetailActions, wireRecent } from "./proposal-actions.js";
import { registerShortcuts } from "./shortcuts.js";

function listHref(status, source, age = "") {
  const params = new URLSearchParams();
  if (status !== "pending") params.set("status", status);
  if (source) params.set("source", source);
  if (age) params.set("age", age);
  const q = params.toString();
  return `#/proposals${q ? `?${q}` : ""}`;
}

function refCell(p, query) {
  return html`<a class="mono wrap" href="${proposalHref(p.id, query)}">${p.ref}</a>${p.isRetire && p.retirement ? html`<div class="small muted">retires in favour of <span class="mono">${p.retirement.successorRef}</span></div>` : ""}`;
}

function sourceChips(counts, active, status, age = "") {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (label, source, n) =>
    html`<a class="chip" href="${listHref(status, source, age)}" ${(active ?? "") === source ? html`aria-current="true"` : ""}>${label} <span class="num">${n}</span></a>`;
  return html`<div class="chips">${chip("All", "", total)}${Object.entries(counts)
    .sort()
    .map(([s, n]) => chip(s, s, n))}</div>`;
}

function listItem(p, query, current) {
  const here = p.id === current;
  const meta = [
    Number.isNaN(Date.parse(p.waitingSince ?? "")) ? "" : when(p.waitingSince),
    p.isRetire ? "retire" : "",
  ].filter(Boolean);
  return html`<li class="review-row"><input type="checkbox" data-select value="${p.id}" data-ref="${p.ref}" aria-label="Select ${p.ref}"><a class="review-item" href="${proposalHref(p.id, query)}" ${here ? html`aria-current="true"` : ""}><span class="mono wrap">${p.ref}</span>${meta.length ? html`<span class="muted small">${meta.map((m, i) => html`${i ? " · " : ""}${m}`)}</span>` : ""}</a></li>`;
}

function pendingView(data, source, query = "", current = "") {
  const shown = data.proposals.filter((p) => !source || p.source === source);
  if (data.fullCount === 0)
    return emptyState(
      "Nothing waiting for review.",
      html`Improve's next proposals will appear here. <a href="#/proposals?status=recent">See recent decisions</a> · <a href="#/improve">How this queue has changed</a>`,
    );
  const groups = new Map();
  for (const p of shown) groups.set(p.source, [...(groups.get(p.source) ?? []), p]);
  return html`${source ? html`<p>Source: <span class="mono">${source}</span> · <a href="${listHref("pending", "")}">Show all sources</a></p>` : ""}
    ${data.totalCount > data.proposals.length ? html`<p class="muted">Showing the first ${data.proposals.length} of ${data.totalCount}.</p>` : ""}
    ${
      shown.length === 0
        ? emptyState("No proposals in this queue.", html`<a href="#/proposals">View all proposals</a>`)
        : [...groups].map(
            ([name, items]) =>
              html`<section data-group="${name}" class="review-group"><h2><label class="select-group"><input type="checkbox" data-select-group aria-label="Select all ${items.length} ${name} ${items.length === 1 ? "proposal" : "proposals"}">${name}</label> <span class="muted num">${items.length}</span></h2>
                <ul class="review-items">${items.map((p) => listItem(p, query, current))}</ul></section>`,
          )
    }`;
}

function outcomeBadge(status) {
  return badge(
    status,
    status === "accepted" ? "ok" : status === "rejected" ? "neutral" : status === "pending" ? "info" : "warn",
  );
}

const DECIDERS = { triage: ["judge", "info"], human: ["you", "ok"] };

function deciderBadge(p) {
  if (p.status === "pending") return "";
  const [label, tone] = DECIDERS[p.decider] ?? ["decider unknown", "neutral"];
  return badge(label, tone);
}

function recentActions(p) {
  if (p.status === "accepted" && p.revertable)
    return html`<button type="button" class="btn-secondary" data-recent-act="revert" data-id="${p.id}">Revert</button>`;
  if (p.status === "rejected")
    return html`<button type="button" class="btn-secondary" data-recent-act="reopen" data-id="${p.id}">Reopen</button>`;
  return "";
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
            html`<table><thead><tr><th>Decided</th><th>Outcome</th><th>By</th><th>Source</th><th>Asset</th><th>Reason</th><th>Undo</th></tr></thead><tbody>${shown.map(
              (p) =>
                html`<tr><td>${when(p.review?.decidedAt ?? p.updatedAt)}<br><span class="muted small">${fmtDateTime(p.review?.decidedAt ?? p.updatedAt)}</span></td><td>${outcomeBadge(p.status)}</td><td>${deciderBadge(p)}</td><td class="mono">${p.source}</td><td>${refCell(p, query)}</td><td class="wrap">${p.review?.reason ?? p.gateDecision?.reason ?? html`<span class="muted">-</span>`}</td><td data-recent-cell>${recentActions(p)}</td></tr>`,
            )}</tbody></table>`,
          )
    }`;
}

const PENDING_LIMIT = 200;
const AGE_BANDS = { underDay: "Under 1 day", underWeek: "1–7 days", older: "7+ days", unknown: "No recorded age" };

const AGE_CLASS = { underDay: "age-1", underWeek: "age-2", older: "age-3", unknown: "age-unknown" };

/** One source's queue by age as an inline bar: a wider, darker part is older (the ramp is ordinal, not categorical). */
function ageBar(row) {
  const total = Object.keys(AGE_BANDS).reduce((sum, key) => sum + (row[key] ?? 0), 0);
  const summary = Object.entries(AGE_BANDS)
    .filter(([key]) => row[key])
    .map(([key, label]) => `${row[key]} ${label.toLowerCase()}`)
    .join(", ");
  let x = 0;
  const parts = Object.keys(AGE_BANDS).map((key) => {
    const width = total ? ((row[key] ?? 0) / total) * 100 : 0;
    const part = width
      ? html`<rect class="${AGE_CLASS[key]}" x="${Math.round(x * 10) / 10}" width="${Math.round(width * 10) / 10}" height="10"/>`
      : "";
    x += width;
    return part;
  });
  return html`<svg class="age-bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${row.source}: ${summary || "nothing waiting"}">${parts}</svg>`;
}

function backlogTable(rows) {
  return tableWrap(
    html`<table><thead><tr><th>Source</th><th>Age</th>${Object.values(AGE_BANDS).map((label) => html`<th class="r">${label}</th>`)}</tr></thead><tbody>${rows.map((row) => html`<tr><th>${row.source}</th><td class="age-cell">${ageBar(row)}</td>${Object.keys(AGE_BANDS).map((key) => html`<td class="r num"><a href="${listHref("pending", row.source, key)}">${row[key]}</a></td>`)}</tr>`)}</tbody></table>`,
  );
}

function backlog(_ctx, data) {
  const totals = Object.fromEntries(
    Object.keys(AGE_BANDS).map((key) => [key, data.backlog.reduce((sum, row) => sum + (row[key] ?? 0), 0)]),
  );
  const parts = Object.entries(AGE_BANDS)
    .filter(([key]) => totals[key])
    .map(([key, label]) => html`<a href="${listHref("pending", "", key)}">${totals[key]} ${label.toLowerCase()}</a>`);
  return html`<section class="queue-summary" aria-label="Waiting for review">
    <p class="queue-sentence"><strong class="num" data-backlog-total>${data.fullCount}</strong> waiting${parts.length ? ": " : "."}${parts.map((part, i) => html`${i ? ", " : ""}${part}`)}${parts.length ? "." : ""} <span class="muted small">Age counts from the last reopening.</span></p>
    <details><summary>By source and age</summary><div data-backlog-table>${backlogTable(data.backlog)}</div></details>
  </section>`;
}

let reviewed = 0;

/** The two-pane review: the pending queue on the left, the open proposal (or a prompt) on the right. */
async function reviewPage(ctx, { detailFor = null } = {}) {
  const source = ctx.query.get("source") ?? "";
  const age = ctx.query.get("age") ?? "";
  const query = String(ctx.query);
  const data = await api("/api/proposals", { status: "pending", source, age, limit: PENDING_LIMIT });
  const detail = detailFor ? detailFor(data) : null;
  const current = detail?.id ?? "";
  const head = html`${pageHeader("Proposals", "Changes akm improve has staged for review.")}
    <nav class="tabs" aria-label="Proposal lists"><a class="tab" href="${listHref("pending", "")}" aria-current="page">Pending</a><a class="tab" href="${listHref("recent", "")}">Recent</a></nav>`;
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
        return pendingView(fresh, source, query, current);
      },
    }),
  );
  const order = data.proposals.filter((p) => !source || p.source === source).map((p) => p.id);
  const at = order.indexOf(current);
  const go = (id) => {
    if (id) location.hash = proposalHref(id, query);
  };
  ctx.after.push((root) =>
    registerShortcuts([
      { key: "j", label: "Open the next proposal in the list", run: () => go(order[at + 1] ?? order[0]) },
      { key: "k", label: "Open the previous proposal", run: () => go(order[at - 1] ?? order.at(-1)) },
      ...(detail?.pending
        ? [
            {
              key: "a",
              label: "Accept (press again to confirm)",
              run: () =>
                (root.querySelector("[data-act=accept-confirm]") ?? root.querySelector("[data-act=accept]"))?.click(),
            },
            {
              key: "r",
              label: "Reject, then choose a reason",
              run: () =>
                (root.querySelector("[data-act=reject-noop]") ?? root.querySelector("[data-act=reject]"))?.click(),
            },
          ]
        : []),
      { key: "u", label: "Undo the decision just made", run: () => root.querySelector("[data-act=undo]")?.click() },
      { key: "n", label: "Go to the next pending proposal", run: () => root.querySelector("[data-next]")?.click() },
      {
        key: "x",
        label: "Select or clear this proposal for a batch",
        run: () => root.querySelector(`.review-row:has([aria-current]) input[data-select]`)?.click(),
      },
      { key: "[", label: "Jump to the previous change in the diff", run: () => jumpHunk(root, -1) },
      { key: "]", label: "Jump to the next change in the diff", run: () => jumpHunk(root, 1) },
    ]),
  );
  const pane = detail
    ? detail.markup
    : html`<div class="state state-empty"><p class="state-title">Select a proposal</p><p>Choose one from the list, or press <kbd>j</kbd> to open the first. Press <kbd>?</kbd> for every shortcut.</p></div>`;
  return html`${head}${backlog(ctx, data)}${age ? html`<p>Waiting age: ${AGE_BANDS[age] ?? age} · <a href="${listHref("pending", source)}">Clear age filter</a></p>` : ""}
    <div class="review" ${detail ? html`data-detail` : ""}>
      <div class="review-list" data-proposal-list><div data-list>${pendingView(data, source, query, current)}</div><div class="batch-bar" data-batch-bar role="region" aria-label="Selection" aria-live="polite" hidden></div><p class="muted small review-count" data-reviewed>${reviewed ? `${reviewed} reviewed this session.` : ""}</p></div>
      <div class="review-pane">${pane}</div>
    </div>`;
}

/** Move focus to the previous or next changed block of the diff on the page. */
function jumpHunk(root, direction) {
  const changed = [...root.querySelectorAll(".sbs-pane:first-child .drow, .dcol.inline .drow")].filter((row) =>
    row.matches(".add, .del"),
  );
  const starts = changed.filter((row) => !row.previousElementSibling?.matches(".add, .del"));
  if (starts.length === 0) return;
  const here = starts.indexOf(document.activeElement);
  const next =
    starts[here === -1 ? (direction > 0 ? 0 : starts.length - 1) : (here + direction + starts.length) % starts.length];
  next.tabIndex = -1;
  next.focus();
}

export async function renderList(ctx) {
  const status = ctx.query.get("status") === "recent" ? "recent" : "pending";
  if (status === "pending") return reviewPage(ctx);
  const source = ctx.query.get("source") ?? "";
  const query = String(ctx.query);
  const data = await api("/api/proposals", { status, source, limit: PENDING_LIMIT });
  const head = html`${pageHeader("Proposals", "Changes akm improve has staged for review.")}
    <nav class="tabs" aria-label="Proposal lists"><a class="tab" href="${listHref("pending", "")}">Pending</a><a class="tab" href="${listHref("recent", "")}" aria-current="page">Recent</a></nav>`;
  ctx.after.push((root) => wireRecent(root));
  return html`${head}${recentView(data, source, query)}`;
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
        ? html`${badge("flagged", "warn")} <pre class="code" tabindex="0" role="group" aria-label="Continuity risk, scrolls sideways">${pretty(r.continuityRisk)}</pre>`
        : html`<span class="muted">none flagged</span>`,
    ],
  ])}</div></section>`;
}

function statusBadges(p, status) {
  return html`${outcomeBadge(status)}${badge(p.source, "info")}${p.isRetire ? badge("retire", "warn") : ""}`;
}

/** "Why akm proposed this": the few facts a reviewer needs before reading the diff. */
function whyBlock(p, findings) {
  const gateText = p.gateDecision
    ? `${p.gateDecision.outcome}${p.gateDecision.reason ? `: ${p.gateDecision.reason}` : ""}`
    : "";
  return html`<section class="why" aria-labelledby="why-title"><h2 id="why-title">Why akm proposed this</h2>${definitionList(
    [
      ["Process", html`<span class="mono">${p.source}</span>`],
      ["Source run", p.sourceRun ? html`<span class="mono">${p.sourceRun}</span>` : ""],
      ["Judge", gateText],
      ["Confidence", typeof p.confidence === "number" ? p.confidence.toFixed(2) : ""],
      [
        "Validation",
        findings.length > 0
          ? `${findings.length} ${findings.length === 1 ? "finding" : "findings"} below`
          : "no findings",
      ],
      ["Waiting", html`${when(p.waitingSince)}`],
    ],
  )}</section>`;
}

export async function renderDetail(ctx) {
  const query = String(ctx.query);
  const data = await api(`/api/proposals/${encodeURIComponent(ctx.param)}`);
  return reviewPage(ctx, {
    detailFor: (list) => {
      const p = data.proposal;
      const findings = data.validation?.findings ?? [];
      const pending = p.status === "pending";
      const source = ctx.query.get("source") ?? "";
      const order = list.proposals.filter((item) => !source || item.source === source).map((item) => item.id);
      const at = order.indexOf(p.id);
      const nextId = pending ? (order[at + 1] ?? order.find((id) => id !== p.id) ?? null) : null;
      const diff = data.diff ? diffSection(data.diff) : null;
      if (diff?.wire) ctx.after.push((root) => diff.wire(root));
      // A proposal whose content equals the asset has nothing to accept (B-15).
      const noop = Boolean(pending && data.diff && !data.diff.isNew && data.diff.before === data.diff.after);
      if (pending) {
        ctx.after.push((root) =>
          wireDetailActions(root, {
            id: p.id,
            nextId,
            query,
            noop,
            onDecided: (status) => {
              const target = root.querySelector("[data-status]");
              if (target) mount(target, statusBadges(p, status));
              if (status === "accepted" || status === "rejected") {
                reviewed += 1;
                const counter = root.querySelector("[data-reviewed]");
                if (counter) counter.textContent = `${reviewed} reviewed this session.`;
              }
              root.querySelector(".review-item[aria-current]")?.setAttribute("data-decided", status);
            },
          }),
        );
      }
      const markup = html`<nav class="crumbs" aria-label="Breadcrumb"><a href="#/proposals${query ? `?${query}` : ""}">Proposals${source ? `: ${source}` : ""}</a> / <span aria-current="page" class="mono wrap">${p.ref}</span></nav>
        <div class="review-bar"><div class="review-bar-id"><h2 class="mono wrap">${p.ref}</h2><div class="badges" data-status>${statusBadges(p, p.status)}</div></div>${pending ? detailActions(nextId, query, noop) : ""}</div>
        ${whyBlock(p, findings)}
        ${p.retirement ? retirementBlock(p.retirement) : ""}
        ${findings.length > 0 ? html`<section><h2>Validation</h2><ul class="plain">${findings.map((f) => html`<li>${badge(f.severity ?? "info", f.severity === "error" ? "fail" : "warn")} <span class="mono small">${f.kind}</span> ${f.message}</li>`)}</ul></section>` : ""}
        <section><h2>Proposed change</h2>${diff ? html`<p class="muted small">${data.diff.isNew ? "New asset. " : ""}Target <span class="mono wrap">${data.diff.targetPath ?? p.proposedTarget?.root ?? ""}</span></p>${diff.markup}` : emptyState("No diff available.", data.diffError ?? "")}</section>
        <details><summary>Proposal details</summary>${definitionList([
          ["Id", html`<span class="mono">${p.id}</span>`],
          ["Created", html`${when(p.createdAt)} <span class="muted small">${fmtDateTime(p.createdAt)}</span>`],
          ["Waiting since", when(p.waitingSince)],
          [
            "Target",
            p.proposedTarget
              ? html`<span class="mono wrap">${p.proposedTarget.root}</span> <span class="muted">(${p.proposedTarget.source})</span>`
              : "",
          ],
          [
            "Review",
            p.review
              ? html`${outcomeBadge(p.review.outcome)} ${p.review.reason ?? ""} ${when(p.review.decidedAt)}`
              : "",
          ],
          [
            "Changes",
            p.changes?.length > 0
              ? html`<ul class="plain">${p.changes.map((c) => html`<li>${badge(c.op, "neutral")} <span class="mono wrap">${c.path}</span></li>`)}</ul>`
              : "",
          ],
        ])}</details>
        <p><a href="${assetHref(p.ref)}">View the asset as it is now</a></p>`;
      return { id: p.id, pending, markup };
    },
  });
}
