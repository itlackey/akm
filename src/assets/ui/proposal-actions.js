// Accepting and rejecting proposals in the browser: the buttons on a proposal's page and the batch bar on the pending
// list. These are the only places the UI writes anything, and each goes through POST /api/proposals/... (lib.js `post`).
//
// Markup is built with `html` and written with `mount`, like every other page. Handlers are attached with
// addEventListener on an element this render created (never on <main>, which outlives the page), so they go away with
// the page. Confirmations are inline: no window.confirm, alert or prompt.

import { ApiError, badge, html, mount, post, proposalHref } from "./lib.js";

const REASON_MAX = 2000;

/** What went wrong, in words a reviewer can act on; the server's own message and code are shown beside it. */
export function describeError(error) {
  const code = error instanceof ApiError ? error.code : "ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const known = {
    PROPOSAL_STALE: "The asset changed since this proposal was made; it can't be accepted.",
    PROPOSAL_NOT_PENDING: "This proposal has already been decided.",
    PROPOSAL_NOT_FOUND: "This proposal no longer exists.",
    ASSET_MUTATION_LEASE_HELD: "Another akm process is writing to the bundle. Try again in a moment.",
    ACCEPT_FAILED: "",
  };
  return { text: known[code] ?? "", message, code };
}

function errorBlock(error) {
  const { text, message, code } = describeError(error);
  return html`<div class="notice notice-fail" role="alert" tabindex="-1">
    <p class="state-title">${text || message}</p>
    ${text && text !== message ? html`<p class="small">${message}</p>` : ""}
    <p class="muted small"><code>${code}</code></p>
  </div>`;
}

function commitLine(commit) {
  return commit
    ? html`Committed <span class="mono">${commit.sha.slice(0, 8)}</span> <span class="muted">${commit.subject}</span>`
    : "No commit was recorded for this change.";
}

// ---- one proposal ------------------------------------------------------------

function detailView(state, nextId, query = "") {
  const busy = state.mode === "busy";
  switch (state.mode) {
    case "done": {
      const { kind, result, commit } = state;
      return html`<div class="notice notice-ok" role="status" tabindex="-1">
          <p class="state-title">${kind === "accept" ? "Accepted" : "Rejected"}</p>
          ${
            kind === "accept"
              ? html`<p>Written to <span class="mono wrap">${result.assetPath}</span>.</p><p>${commitLine(commit)}</p>`
              : html`<p>The reason was recorded: <em>${result.reason}</em></p>`
          }
        </div>
        <p class="btn-row">${nextId ? html`<a class="btn" href="${proposalHref(nextId, query)}">Next pending</a>` : ""}<a class="btn btn-secondary" href="#/proposals${query ? `?${query}` : ""}">Back to queue</a></p>
        ${nextId ? "" : html`<p class="muted small">No other proposal is waiting in this queue.${query ? html` <a href="#/proposals">View all proposals</a>` : ""}</p>`}`;
    }
    case "confirm-accept":
      return html`<p class="state-title">Accept this proposal?</p>
        <p class="muted">The asset is written to its bundle and the change is committed.</p>
        <p class="btn-row"><button type="button" data-act="accept-confirm">Confirm accept</button><button type="button" class="btn-secondary" data-act="cancel">Cancel</button></p>`;
    case "reject":
    case "busy":
      if (state.mode === "busy" && state.kind === "accept") {
        return html`<p class="btn-row"><button type="button" disabled>Accept</button><button type="button" class="btn-secondary" disabled>Reject</button></p>
          <p class="muted" role="status">Accepting...</p>`;
      }
      return html`${state.error ? errorBlock(state.error) : ""}<label for="reject-reason"><strong>Why reject this proposal?</strong> <span class="muted small">Required, up to ${REASON_MAX} characters.</span></label>
        <textarea id="reject-reason" data-reason rows="3" maxlength="${REASON_MAX}" required ${busy ? "disabled" : ""}>${state.reason}</textarea>
        ${state.reasonMissing ? html`<p class="field-error" role="alert">Enter a reason before rejecting.</p>` : ""}
        <p class="btn-row"><button type="button" class="btn-danger" data-act="reject-confirm" ${busy ? "disabled" : ""}>Confirm reject</button><button type="button" class="btn-secondary" data-act="cancel" ${busy ? "disabled" : ""}>Cancel</button></p>
        ${busy ? html`<p class="muted" role="status">Rejecting...</p>` : ""}`;
    default:
      return html`${state.error ? errorBlock(state.error) : ""}
        <p class="btn-row"><button type="button" data-act="accept">Accept</button><button type="button" class="btn-secondary" data-act="reject">Reject</button></p>`;
  }
}

/** The action area of a pending proposal's page; {@link wireDetailActions} brings it to life. */
export function detailActions(nextId, query = "") {
  return html`<section class="actions" data-actions aria-label="Decide this proposal">${detailView({ mode: "idle" }, nextId, query)}</section>`;
}

/**
 * Attach the Accept / Reject controls inside `root`. `onDecided(status)` runs after the server confirms, so the page can
 * show the new status.
 */
export function wireDetailActions(root, { id, nextId, query = "", onDecided }) {
  const region = root.querySelector("[data-actions]");
  if (!region) return;
  let state = { mode: "idle", reason: "" };
  const draw = (focus) => {
    mount(region, detailView(state, nextId, query));
    region.querySelector(focus)?.focus();
  };

  const run = async (kind, path, body) => {
    state = { ...state, mode: "busy", kind, error: null };
    draw();
    try {
      const result = await post(path, body);
      state = { mode: "done", kind, result, commit: result.commit ?? null, reason: state.reason };
      draw("[role=status]");
      onDecided?.(kind === "accept" ? "accepted" : "rejected");
    } catch (error) {
      state = { mode: kind === "reject" ? "reject" : "idle", reason: state.reason, error };
      draw("[role=alert]");
    }
  };

  region.addEventListener("input", (event) => {
    if (!event.target.matches("[data-reason]")) return;
    state.reason = event.target.value;
    if (state.reasonMissing && state.reason.trim() !== "") {
      state.reasonMissing = false;
      region.querySelector(".field-error")?.remove();
    }
  });
  region.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button || button.disabled || state.mode === "busy") return;
    const base = `/api/proposals/${encodeURIComponent(id)}`;
    switch (button.dataset.act) {
      case "accept":
        state = { mode: "confirm-accept", reason: state.reason };
        draw("[data-act=accept-confirm]");
        break;
      case "accept-confirm":
        run("accept", `${base}/accept`, {});
        break;
      case "reject":
        state = { mode: "reject", reason: state.reason };
        draw("[data-reason]");
        break;
      case "reject-confirm": {
        const reason = state.reason.trim();
        if (reason === "" || reason.length > REASON_MAX) {
          state = { ...state, mode: "reject", reasonMissing: true };
          draw("[data-reason]");
          break;
        }
        run("reject", `${base}/reject`, { reason });
        break;
      }
      case "cancel": {
        const control = state.mode === "reject" ? "reject" : "accept";
        state = { mode: "idle", reason: state.reason };
        draw(`[data-act=${control}]`);
        break;
      }
    }
  });
}

// ---- the pending list --------------------------------------------------------

function batchView(state, count) {
  switch (state.mode) {
    case "confirm":
      return html`<span>Accept ${state.ids.length} ${state.ids.length === 1 ? "proposal" : "proposals"}? They are written and committed together.</span>
        <span class="btn-row"><button type="button" data-act="batch-confirm">Confirm accept</button><button type="button" class="btn-secondary" data-act="batch-cancel">Cancel</button></span>`;
    case "busy":
      return html`<span role="status">Accepting ${state.ids.length}...</span>
        <span class="btn-row"><button type="button" disabled>Accept selected</button></span>`;
    case "results": {
      const { data } = state;
      return html`<div class="batch-results" role="status" tabindex="-1">
          <p class="state-title">${data.accepted} accepted${data.failed > 0 ? html`, ${data.failed} failed` : ""}</p>
          <p class="small">${commitLine(data.commit)}</p>
          <ul class="plain">${data.results.map((r) => {
            const label = state.refs[r.id] ?? r.ref ?? r.id;
            return r.ok
              ? html`<li>${badge("accepted", "ok")} <span class="mono wrap">${label}</span></li>`
              : html`<li>${badge("failed", "fail")} <span class="mono wrap">${label}</span> <span class="small">${describeError(new ApiError(0, r.code, r.error)).text || r.error}</span> <code class="small muted">${r.code}</code></li>`;
          })}</ul>
        </div>
        <span class="btn-row"><button type="button" class="btn-secondary" data-act="batch-dismiss">Dismiss</button></span>`;
    }
    case "error":
      return html`${errorBlock(state.error)}<span class="btn-row"><button type="button" class="btn-secondary" data-act="batch-dismiss">Dismiss</button></span>`;
    default:
      return count === 0
        ? html``
        : html`<span class="num">${count} selected</span>
          <span class="btn-row"><button type="button" data-act="batch-start">Accept selected</button><button type="button" class="btn-secondary" data-act="batch-clear">Clear</button></span>`;
  }
}

/**
 * Attach selection and the batch bar inside `root`. `reload()` resolves to fresh list markup, shown after a batch so the
 * accepted rows are gone while the per-id results stay in the bar.
 */
export function wireBatch(root, { reload }) {
  const page = root.querySelector("[data-proposal-list]");
  if (!page) return;
  const list = page.querySelector("[data-list]");
  const bar = page.querySelector("[data-batch-bar]");
  let state = { mode: "idle" };

  const boxes = () => [...list.querySelectorAll("input[data-select]")];
  const chosen = () => boxes().filter((box) => box.checked);
  const draw = (focus) => {
    mount(bar, batchView(state, chosen().length));
    bar.hidden = bar.childElementCount === 0;
    bar.querySelector(focus)?.focus();
  };
  const syncGroups = () => {
    for (const section of list.querySelectorAll("section[data-group]")) {
      const group = section.querySelector("input[data-select-group]");
      const rows = [...section.querySelectorAll("input[data-select]")];
      const on = rows.filter((box) => box.checked).length;
      group.checked = rows.length > 0 && on === rows.length;
      group.indeterminate = on > 0 && on < rows.length;
    }
  };

  page.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("input[data-select-group]")) {
      for (const box of target.closest("section[data-group]").querySelectorAll("input[data-select]")) {
        box.checked = target.checked;
      }
    } else if (!target.matches("input[data-select]")) {
      return;
    }
    syncGroups();
    if (state.mode === "idle") draw();
  });

  page.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button || button.disabled || state.mode === "busy") return;
    switch (button.dataset.act) {
      case "batch-start": {
        const picked = chosen();
        state = {
          mode: "confirm",
          ids: picked.map((box) => box.value),
          refs: Object.fromEntries(picked.map((box) => [box.value, box.dataset.ref])),
        };
        draw("[data-act=batch-confirm]");
        break;
      }
      case "batch-clear":
        for (const box of chosen()) box.checked = false;
        syncGroups();
        draw();
        break;
      case "batch-cancel":
      case "batch-dismiss":
        state = { mode: "idle" };
        draw("[data-act=batch-start]");
        if (bar.hidden) list.querySelector("input[data-select]")?.focus();
        break;
      case "batch-confirm": {
        const { ids, refs } = state;
        state = { mode: "busy", ids, refs };
        draw();
        try {
          const data = await post("/api/proposals/accept", { ids });
          state = { mode: "results", data, refs };
        } catch (error) {
          state = { mode: "error", error };
        }
        try {
          mount(list, await reload());
        } catch {
          // The results stay visible; the list refreshes on the next visit.
        }
        draw(".batch-results, [role=alert]");
        break;
      }
    }
  });
}
