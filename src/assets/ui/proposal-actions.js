// Accepting and rejecting proposals in the browser: the buttons on a proposal's page and the batch bar on the pending
// list. These are the only places the UI writes anything, and each goes through POST /api/proposals/... (lib.js `post`).
//
// Markup is built with `html` and written with `mount`, like every other page. Handlers are attached with
// addEventListener on an element this render created (never on <main>, which outlives the page), so they go away with
// the page. Confirmations are inline: no window.confirm, alert or prompt.

import { ApiError, badge, html, mount, post, proposalHref } from "./lib.js";

const REASON_MAX = 2000;
const NOOP_REASON = "No-op: the proposed content matches the current asset.";
const REASON_CHIPS = ["Wrong", "Stale", "Duplicate", "Style", "Other"];

/** The reason sent to the server: the chosen chip, then any detail. */
function composeReason(chip, text) {
  return [chip, text.trim()].filter(Boolean).join(": ");
}

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

function detailView(state, nextId, query = "", noop = false) {
  const busy = state.mode === "busy";
  switch (state.mode) {
    case "done": {
      const { kind, result, commit } = state;
      const title = { accept: "Accepted", reject: "Rejected", revert: "Reverted" }[kind];
      const detail =
        kind === "accept"
          ? html`<p>Written to <span class="mono wrap">${result.assetPath}</span>.</p><p>${commitLine(commit)}</p>`
          : kind === "reject"
            ? html`<p>The reason was recorded: <em>${result.reason}</em></p>`
            : html`<p>Restored from the backup taken when it was accepted.</p>`;
      const undo =
        kind === "accept" && result.proposal?.revertable
          ? html`<button type="button" class="btn-secondary" data-act="undo">Undo <kbd>u</kbd></button>`
          : "";
      const reopen =
        kind === "reject" ? html`<button type="button" class="btn-secondary" data-act="reopen">Reopen</button>` : "";
      return html`<div class="notice notice-ok" role="status" tabindex="-1" data-decided>
          <p class="state-title">${title}</p>${detail}
        </div>
        <p class="btn-row">${undo}${reopen}${nextId ? html`<a class="btn" data-next href="${proposalHref(nextId, query)}">Next pending <kbd>n</kbd></a>` : ""}<a class="btn btn-secondary" href="#/proposals${query ? `?${query}` : ""}">Back to queue</a></p>
        ${nextId ? "" : html`<p class="muted small">No other proposal is waiting in this queue.${query ? html` <a href="#/proposals">View all proposals</a>` : ""}</p>`}`;
    }
    case "confirm-accept":
      return html`<p class="state-title">Accept this proposal?</p>
        <p class="muted">The asset is written to its bundle and the change is committed.</p>
        <p class="btn-row"><button type="button" data-act="accept-confirm">Confirm accept</button><button type="button" class="btn-secondary" data-act="cancel">Cancel</button></p>`;
    case "reject":
    case "busy":
      if (state.mode === "busy" && state.kind === "accept") {
        // The buttons stay in place and only report busy, so focus has somewhere to be (B-27).
        return html`<p class="btn-row"><button type="button" aria-disabled="true">Accept</button><button type="button" class="btn-secondary" aria-disabled="true">Reject</button></p>
          <p class="muted" role="status" tabindex="-1">Accepting...</p>`;
      }
      return html`${state.error ? errorBlock(state.error) : ""}<fieldset class="reason-chips" role="radiogroup" aria-label="Why reject this proposal?"><legend><strong>Why reject this proposal?</strong></legend><div class="segmented">${REASON_CHIPS.map((chip) => html`<label><input type="radio" name="reject-chip" value="${chip}" ${state.chip === chip ? html`checked` : ""} ${busy ? html`disabled` : ""}><span>${chip}</span></label>`)}</div></fieldset>
        <label for="reject-reason"><strong>Details</strong> <span class="muted small" id="reject-reason-hint">${state.chip === "Other" ? "Required for Other" : "Optional with a reason above"}, up to ${REASON_MAX} characters.</span></label>
        <textarea id="reject-reason" data-reason rows="3" required aria-describedby="reject-reason-hint${state.reasonError ? " reject-reason-error" : ""}" ${state.reasonError ? html`aria-invalid="true"` : ""} ${busy ? "disabled" : ""}>${state.reason}</textarea>
        ${state.reasonError ? html`<p class="field-error" id="reject-reason-error" role="alert">${state.reasonError}</p>` : ""}
        <p class="btn-row"><button type="button" class="btn-danger" data-act="reject-confirm" ${busy ? html`aria-disabled="true"` : ""}>Confirm reject</button><button type="button" class="btn-secondary" data-act="cancel" ${busy ? html`aria-disabled="true"` : ""}>Cancel</button></p>
        ${busy ? html`<p class="muted" role="status" tabindex="-1">Rejecting...</p>` : ""}`;
    default:
      if (noop) {
        return html`${state.error ? errorBlock(state.error) : ""}
          <div class="notice notice-warn"><p class="state-title">This proposal changes nothing</p><p>The proposed content matches the asset as it is, so accepting would write nothing and record no commit. Rejecting it clears it from the queue.</p></div>
          <p class="btn-row"><button type="button" data-act="reject-noop">Reject as no-op</button><button type="button" class="btn-secondary" data-act="accept">Accept anyway</button></p>`;
      }
      return html`${state.error ? errorBlock(state.error) : ""}
        <p class="btn-row"><button type="button" data-act="accept">Accept</button><button type="button" class="btn-secondary" data-act="reject">Reject</button></p>`;
  }
}

/** The action area of a pending proposal's page; {@link wireDetailActions} brings it to life. */
export function detailActions(nextId, query = "", noop = false) {
  return html`<section class="actions" data-actions aria-label="Decide this proposal">${detailView({ mode: "idle" }, nextId, query, noop)}</section>`;
}

/**
 * Attach the Accept / Reject controls inside `root`. `onDecided(status)` runs after the server confirms, so the page can
 * show the new status.
 */
export function wireDetailActions(root, { id, nextId, query = "", noop = false, onDecided }) {
  const region = root.querySelector("[data-actions]");
  if (!region) return;
  let state = { mode: "idle", reason: "", chip: "" };
  const draw = (focus) => {
    mount(region, detailView(state, nextId, query, noop));
    region.querySelector(focus)?.focus();
  };

  const run = async (kind, path, body) => {
    state = { ...state, mode: "busy", kind, error: null };
    draw("[role=status]");
    try {
      const result = await post(path, body);
      if (kind === "reopen") {
        state = { mode: "idle", reason: "", chip: "" };
        draw("[data-act=accept], [data-act=reject-noop]");
        onDecided?.("pending");
        return;
      }
      state = { mode: "done", kind, result, commit: result.commit ?? null, reason: state.reason, chip: state.chip };
      draw("[role=status]");
      onDecided?.({ accept: "accepted", reject: "rejected", revert: "reverted" }[kind]);
    } catch (error) {
      state = { mode: kind === "reject" ? "reject" : "idle", reason: state.reason, chip: state.chip, error };
      draw("[role=alert]");
    }
  };

  region.addEventListener("change", (event) => {
    if (!event.target.matches("input[name=reject-chip]")) return;
    state.chip = event.target.value;
    if (state.reasonError) {
      state = { ...state, reasonError: "" };
      draw(`input[name=reject-chip][value="${state.chip}"]`);
    }
  });
  region.addEventListener("input", (event) => {
    if (!event.target.matches("[data-reason]")) return;
    state.reason = event.target.value;
    if (state.reasonError && state.reason.trim() !== "" && state.reason.trim().length <= REASON_MAX) {
      state.reasonError = "";
      region.querySelector(".field-error")?.remove();
      event.target.removeAttribute("aria-invalid");
      event.target.setAttribute("aria-describedby", "reject-reason-hint");
    }
  });
  // Esc backs out of a confirmation and returns focus to the control that opened it.
  region.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || (state.mode !== "confirm-accept" && state.mode !== "reject")) return;
    event.preventDefault();
    const control = state.mode === "reject" ? "reject" : "accept";
    state = { mode: "idle", reason: state.reason, chip: state.chip };
    draw(`[data-act=${control}]`);
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
        state = { mode: "reject", reason: state.reason, chip: state.chip };
        draw("input[name=reject-chip]");
        break;
      case "reject-noop":
        state = { mode: "reject", reason: NOOP_REASON, chip: "Other" };
        draw("[data-act=reject-confirm]");
        break;
      case "undo":
        run("revert", `${base}/revert`, {});
        break;
      case "reopen":
        run("reopen", `${base}/reopen`, {});
        break;
      case "reject-confirm": {
        const reason = composeReason(state.chip, state.reason);
        const reasonError =
          state.chip === "" && state.reason.trim() === ""
            ? "Choose a reason or write one before rejecting."
            : state.chip === "Other" && state.reason.trim() === ""
              ? "Say why in the details when the reason is Other."
              : reason.length > REASON_MAX
                ? `The reason is ${reason.length} characters; the limit is ${REASON_MAX}. Shorten it by ${reason.length - REASON_MAX}.`
                : "";
        if (reasonError) {
          state = { ...state, mode: "reject", reasonError };
          draw("[data-reason]");
          break;
        }
        run("reject", `${base}/reject`, { reason });
        break;
      }
      case "cancel": {
        const control = state.mode === "reject" ? "reject" : "accept";
        state = { mode: "idle", reason: state.reason, chip: state.chip };
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
    case "reject":
      return html`<label for="batch-reason"><strong>Why reject ${state.ids.length} ${state.ids.length === 1 ? "proposal" : "proposals"}?</strong> <span class="muted small">One reason is recorded for each. Required, up to ${REASON_MAX} characters.</span></label>
        <textarea id="batch-reason" data-batch-reason rows="2" ${state.error ? html`aria-invalid="true" aria-describedby="batch-reason-error"` : ""}>${state.reason ?? ""}</textarea>
        ${state.error ? html`<p class="field-error" id="batch-reason-error" role="alert">${state.error}</p>` : ""}
        <span class="btn-row"><button type="button" class="btn-danger" data-act="batch-reject-confirm">Confirm reject</button><button type="button" class="btn-secondary" data-act="batch-cancel">Cancel</button></span>`;
    case "busy":
      return html`<span role="status" tabindex="-1">${state.verb === "reject" ? "Rejecting" : "Accepting"} ${state.ids.length}...</span>
        <span class="btn-row"><button type="button" aria-disabled="true">${state.verb === "reject" ? "Reject selected" : "Accept selected"}</button></span>`;
    case "results": {
      const { data } = state;
      return html`<div class="batch-results" role="status" tabindex="-1">
          <p class="state-title">${data.rejected ?? data.accepted} ${state.verb === "reject" ? "rejected" : "accepted"}${data.failed > 0 ? html`, ${data.failed} failed` : ""}</p>
          ${state.verb === "reject" ? html`<p class="small">Each rejection can be reopened from Recent.</p>` : html`<p class="small">${commitLine(data.commit)}</p>`}
          <ul class="plain">${data.results.map((r) => {
            const label = state.refs[r.id] ?? r.ref ?? r.id;
            return r.ok
              ? html`<li>${badge(state.verb === "reject" ? "rejected" : "accepted", state.verb === "reject" ? "neutral" : "ok")} <span class="mono wrap">${label}</span></li>`
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
          <span class="btn-row"><button type="button" data-act="batch-start">Accept selected</button><button type="button" class="btn-secondary" data-act="batch-reject-start">Reject selected…</button><button type="button" class="btn-secondary" data-act="batch-clear">Clear</button></span>`;
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
      case "batch-reject-start": {
        const picked = chosen();
        state = {
          mode: "reject",
          ids: picked.map((box) => box.value),
          refs: Object.fromEntries(picked.map((box) => [box.value, box.dataset.ref])),
        };
        draw("[data-batch-reason]");
        break;
      }
      case "batch-reject-confirm": {
        const { ids, refs } = state;
        const reason = bar.querySelector("[data-batch-reason]")?.value.trim() ?? "";
        if (reason === "" || reason.length > REASON_MAX) {
          state = {
            mode: "reject",
            ids,
            refs,
            reason,
            error:
              reason === ""
                ? "Enter a reason before rejecting."
                : `The reason is ${reason.length} characters; the limit is ${REASON_MAX}.`,
          };
          draw("[data-batch-reason]");
          break;
        }
        state = { mode: "busy", verb: "reject", ids, refs };
        draw("[role=status]");
        try {
          const data = await post("/api/proposals/reject", { ids, reason });
          state = { mode: "results", verb: "reject", data, refs };
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
        state = { mode: "busy", verb: "accept", ids, refs };
        draw("[role=status]");
        try {
          const data = await post("/api/proposals/accept", { ids });
          state = { mode: "results", verb: "accept", data, refs };
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

// ---- the recent list: undo a decision in place ---------------------------------

/** Revert and Reopen buttons in the Recent table: the first click asks, the second does it. */
export function wireRecent(root) {
  const table = root.querySelector("[data-recent-cell]")?.closest("table");
  if (!table) return;
  const labels = { revert: "Revert this change?", reopen: "Reopen this proposal?" };
  const button = (act, id) =>
    html`<button type="button" class="btn-secondary" data-recent-act="${act}" data-id="${id}">${act === "revert" ? "Revert" : "Reopen"}</button>`;
  table.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-recent-act]");
    const cell = event.target.closest("[data-recent-cell]");
    if (!cell) return;
    const act = trigger?.dataset.recentAct;
    if (event.target.closest("[data-recent-cancel]")) {
      mount(cell, button(cell.__pending.act, cell.__pending.id));
      cell.querySelector("[data-recent-act]")?.focus();
      return;
    }
    if (event.target.closest("[data-recent-go]")) {
      const { act: confirmed, id } = cell.__pending;
      mount(cell, html`<span role="status" tabindex="-1">Working...</span>`);
      cell.querySelector("[role=status]")?.focus();
      try {
        await post(`/api/proposals/${encodeURIComponent(id)}/${confirmed}`, {});
        mount(
          cell,
          html`<span role="status" tabindex="-1" class="text-ok">${confirmed === "revert" ? "Reverted" : "Reopened"}</span>`,
        );
      } catch (error) {
        const { text, message } = describeError(error);
        mount(cell, html`<span role="alert" tabindex="-1" class="text-fail">${text || message}</span>`);
      }
      cell.querySelector("[role=status], [role=alert]")?.focus();
      return;
    }
    if (!act || trigger.disabled) return;
    cell.__pending = { act, id: trigger.dataset.id };
    mount(
      cell,
      html`<span class="small">${labels[act]}</span> <button type="button" class="btn-danger" data-recent-go>Confirm</button> <button type="button" class="btn-secondary" data-recent-cancel>Cancel</button>`,
    );
    cell.querySelector("[data-recent-go]")?.focus();
  });
}
