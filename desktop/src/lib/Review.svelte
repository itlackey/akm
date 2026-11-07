<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { navigate } from "./navigation";
  import { refreshPending, workspace } from "./state/workspace.svelte";
  import { showToast } from "./state/toasts.svelte";
  import { onDestroy, tick, untrack } from "svelte";
  import { api, date, title, toggleSelection } from "./client";
  import Icon from "./Icon.svelte";
  import ReviewDetail from "./ReviewDetail.svelte";
  import ReviewFinished from "./ReviewFinished.svelte";
  import ReviewShelf from "./ReviewShelf.svelte";
  import {
    ageBands,
    activityReturn,
    batchOutcome,
    clip,
    commitOutcome,
    conceptLocation,
    decisionVerb,
    nextAfterDecision,
    proposalHref,
    queueState,
    record,
    rejectionError,
    rejectionReason,
    settleDecision,
    text,
    withoutDecided,
    type BatchOutcome,
    type LastDecision,
    type ReviewProposal,
    type ReviewQueue,
  } from "./review-model";
  import type { ProposalDetail, WriteResult } from "./types";

  let { id = "", query = new URLSearchParams() }: { id?: string; query?: URLSearchParams } = $props();

  let status = $state("pending"),
    source = $state(""),
    age = $state(""),
    week = $state(""),
    outcome = $state(""),
    queue = $state<ReviewQueue | null>(null),
    detail = $state<ProposalDetail | null>(null),
    selected = $state<string[]>([]);
  let failure = $state(""),
    queueError = $state(""),
    detailError = $state(""),
    reasonError = $state(""),
    busy = $state(false),
    loading = $state(false),
    opening = $state(false),
    intent = $state(""),
    reason = $state(""),
    choice = $state(""),
    reviewed = $state(0),
    finished = $state(false),
    shortcutsEnabled = $state(false),
    last = $state<LastDecision | null>(null),
    report = $state<(BatchOutcome & { verb: string; total: number }) | null>(null);
  let desiredId = $state("");
  let queueGeneration = 0,
    detailGeneration = 0,
    previousRoute = "",
    queuedAction = "",
    focusNext = false,
    decisionTrigger: HTMLElement | null = null,
    decisionTriggerKey = "",
    afterFocus = "",
    focusQueue = false;
  let region = $state<HTMLElement>(),
    scroller = $state<HTMLElement>(),
    shelf = $state<HTMLElement>(),
    detailHeading = $state<HTMLHeadingElement>(),
    finishedHeading = $state<HTMLHeadingElement>();

  const current = $derived(detail?.proposal as ReviewProposal | undefined);
  const analyticsReturn = $derived(activityReturn(query.get("returnTo")));
  const filtered = $derived(!!(source || age || week || outcome));
  // Nothing pending matches: after the last decision, and also when the page is opened with an empty queue.
  const showFinished = $derived(
    !desiredId && status === "pending" && (finished || (!!queue && queueState(queue) === "finished")),
  );
  const noop = $derived(
    !!(
      current?.status === "pending" &&
      detail?.diff &&
      !detail.diff.redacted &&
      !detail.diff.truncated &&
      typeof detail.diff.before === "string" &&
      detail.diff.before === detail.diff.after
    ),
  );

  $effect(() => {
    const proposal = id,
      params = String(query);
    untrack(() => syncRoute(proposal, params));
  });
  // Narrow toasts sit above the sticky shelf, so they never cover its buttons.
  $effect(() => {
    const element = shelf;
    if (!element) return;
    const root = document.documentElement;
    // Toasts sit above the shelf wherever it is on screen: at the page end the sticky shelf is not at the viewport bottom.
    const update = () => {
      root.style.setProperty("--shelf-h", `${Math.max(0, innerHeight - element.getBoundingClientRect().top)}px`);
      // A control focused just above the sticky shelf scrolls clear of it.
      root.style.scrollPaddingBottom = `${element.offsetHeight + 8}px`;
    };
    const observer = new ResizeObserver(update);
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    update();
    observer.observe(element);
    return () => {
      observer.disconnect();
      removeEventListener("scroll", update);
      removeEventListener("resize", update);
      root.style.removeProperty("--shelf-h");
      root.style.removeProperty("scroll-padding-bottom");
    };
  });
  onDestroy(() => {
    ++queueGeneration;
    ++detailGeneration;
  });

  function syncRoute(proposal: string, params: string) {
    const key = `${proposal}?${params}`;
    if (previousRoute === key) return;
    previousRoute = key;
    const nextStatus = query.get("status") === "recent" ? "recent" : "pending";
    const nextSource = query.get("source") ?? "",
      nextAge = query.get("age") ?? "";
    const nextWeek = query.get("week") ?? "",
      nextOutcome = query.get("class") ?? "";
    const changed =
      nextStatus !== status || nextSource !== source || nextAge !== age || nextWeek !== week || nextOutcome !== outcome;
    status = nextStatus;
    source = nextSource;
    age = nextAge;
    week = nextWeek;
    outcome = nextOutcome;
    if (changed || !queue) {
      if (changed) {
        queue = null;
        if (finished) focusQueue = true;
        finished = false;
      }
      selected = [];
      void load();
    }
    if (proposal !== desiredId) {
      const previousId = desiredId;
      desiredId = proposal;
      intent = "";
      failure = "";
      reasonError = "";
      reason = "";
      choice = "";
      if (proposal) {
        finished = false;
        void open(proposal);
      } else {
        ++detailGeneration;
        detail = null;
        detailError = "";
        opening = false;
      }
      if (!proposal && previousId && !changed && !finished) void restoreQueueFocus(previousId);
    }
  }
  async function fetchQueue(): Promise<ReviewQueue> {
    return api<ReviewQueue>("/proposals", { status, source, age, week, class: outcome, limit: "200" });
  }
  async function load() {
    const generation = ++queueGeneration;
    queueError = "";
    loading = true;
    try {
      const next = await fetchQueue();
      if (generation === queueGeneration) {
        queue = next;
        if (focusQueue) {
          focusQueue = false;
          await tick();
          (region?.querySelector<HTMLElement>(".review-item") ?? region?.querySelector<HTMLElement>("h1"))?.focus();
        }
      }
    } catch (e) {
      if (generation === queueGeneration) queueError = (e as Error).message;
    } finally {
      if (generation === queueGeneration) loading = false;
    }
  }
  async function open(proposal: string) {
    const generation = ++detailGeneration;
    detailError = "";
    detail = null;
    opening = true;
    try {
      const next = await api<ProposalDetail>(`/proposals/${encodeURIComponent(proposal)}`);
      if (generation === detailGeneration) {
        detail = next;
        if (queuedAction) {
          const action = queuedAction;
          queuedAction = "";
          void begin(action);
        }
      }
    } catch (e) {
      if (generation === detailGeneration) detailError = (e as Error).message;
    } finally {
      if (generation === detailGeneration) {
        opening = false;
        await tick();
        if (generation === detailGeneration) {
          if (focusNext) {
            focusNext = false;
            if (scroller) scroller.scrollTop = 0;
            detailHeading?.focus({ preventScroll: true });
          } else if (!intent && matchMedia("(max-width:850px)").matches) {
            // The heading is already near the top: focus it where it is. Scroll only when it is out of sight.
            detailHeading?.focus({ preventScroll: true });
            const box = detailHeading?.getBoundingClientRect();
            const top = document.querySelector(".desktop-topbar")?.getBoundingClientRect().bottom ?? 0;
            if (box && (box.top < top || box.bottom > innerHeight)) detailHeading?.scrollIntoView({ block: "start" });
          }
        }
      }
    }
  }
  async function restoreQueueFocus(previousId: string) {
    await tick();
    [...(region?.querySelectorAll<HTMLAnchorElement>(".review-item") ?? [])]
      .find((link) => link.dataset.id === previousId)
      ?.focus();
  }
  function select(next: string, replace = false) {
    void navigate(proposalHref(next, query), replace);
  }
  function queueDate(value: unknown) {
    const parsed = new Date(String(value ?? ""));
    return Number.isNaN(parsed.valueOf())
      ? "Date unavailable"
      : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  /** Undo… and Reopen… open the decided proposal with its confirmation ready, wherever the reviewer is. */
  function openDecided(proposal: string, action: "revert" | "reopen") {
    if (desiredId === proposal) void begin(action);
    else {
      queuedAction = action;
      select(proposal);
    }
  }
  function filter(key: string, value: string) {
    const params = new URLSearchParams(query);
    params.delete("id");
    if (value) params.set(key, value);
    else params.delete(key);
    void navigate(proposalHref("", params));
  }
  async function begin(action: string) {
    const active = document.activeElement;
    decisionTrigger = active instanceof HTMLElement && active !== document.body ? active : null;
    decisionTriggerKey = action;
    intent = action;
    failure = "";
    reasonError = "";
    report = null;
    if (noop && action === "reject") {
      choice = "Other";
      reason = "No-op: the proposed content matches the current asset.";
    }
    await tick();
    region
      ?.querySelector<HTMLElement>(action.includes("reject") ? '[name="reject-choice"]' : "[data-confirm]")
      ?.focus();
  }
  async function cancel() {
    intent = "";
    failure = "";
    reasonError = "";
    await tick();
    if (decisionTrigger?.isConnected) decisionTrigger.focus();
    else
      (
        region?.querySelector<HTMLElement>(`[data-decision="${decisionTriggerKey}"]`) ??
        region?.querySelector<HTMLElement>("[data-primary-decision]")
      )?.focus();
  }
  async function decide() {
    if (!intent || busy) return;
    if (intent.includes("reject")) {
      reasonError = rejectionError(choice, reason);
      if (reasonError) return;
    }
    reasonError = "";
    const batch = intent.startsWith("batch-"),
      action = intent.replace("batch-", "");
    if ((!batch && !current) || (batch && !selected.length)) return;
    busy = true;
    failure = "";
    report = null;
    afterFocus = "";
    try {
      if (batch) await decideBatch(action);
      else await decideOne(action, current!);
    } finally {
      busy = false;
    }
    // Controls are disabled while busy, so focus is placed once they are enabled again.
    await tick();
    if (afterFocus === "confirm") region?.querySelector<HTMLElement>("[data-confirm]")?.focus();
    else if (afterFocus === "primary")
      (region?.querySelector<HTMLElement>("[data-primary-decision]") ?? detailHeading)?.focus({ preventScroll: true });
    else if (afterFocus === "report") region?.querySelector<HTMLElement>("[data-report]")?.focus();
    afterFocus = "";
  }
  async function decideOne(action: string, target: ReviewProposal) {
    const label = title(target);
    const advance = status === "pending" && (action === "accept" || action === "reject");
    const order = (queue?.proposals ?? []).map((p) => p.id);
    const payload = action === "reject" ? { reason: rejectionReason(choice, reason) } : {};
    const result = await settleDecision(
      () => api<WriteResult>(`/proposals/${encodeURIComponent(target.id)}/${action}`, {}, payload),
      async (receipt) => {
        const revertable = !!record(receipt.proposal).revertable;
        intent = "";
        reason = "";
        choice = "";
        last = { action, id: target.id, ref: target.ref, title: label, revertable };
        if (advance) {
          reviewed++;
          if (queue) queue = withoutDecided(queue, [target.id]);
          if (workspace.pendingCount !== null) workspace.pendingCount = Math.max(0, workspace.pendingCount - 1);
        }
        showToast({
          // One decision toast at a time: the newest replaces the last (Recent decisions keeps the history).
          key: "decision",
          title: `${decisionVerb(action)} “${label}”`,
          detail:
            action === "accept"
              ? `${target.ref}\n${commitOutcome(receipt.commit)}`
              : action === "reject"
                ? `${target.ref}\nReason: ${clip(String("reason" in payload ? payload.reason : ""), 60)}`
                : action === "revert"
                  ? "Restored the backup kept at acceptance."
                  : "Back in the pending queue.",
          ...(action === "accept" && revertable
            ? { action: { label: "Undo…", run: () => openDecided(target.id, "revert") } }
            : action === "reject"
              ? { action: { label: "Reopen…", run: () => openDecided(target.id, "reopen") } }
              : {}),
        });
        queue = await fetchQueue();
      },
    );
    if (result.status === "failed") {
      failure = result.error;
      afterFocus = "confirm";
      return;
    }
    if (result.refreshError)
      showToast({
        kind: "warning",
        key: "queue-refresh",
        title: "Decision recorded; the queue did not refresh.",
        detail: `${result.refreshError}. Counts may be out of date.`,
        action: { label: "Refresh queue", run: refreshFromToast },
      });
    void refreshPending();
    if (advance) await advanceFrom(order, target.id);
    else {
      await open(target.id);
      afterFocus = "primary";
    }
  }
  /** Open the next remaining proposal in the queue's order, or show that the queue is finished. */
  async function advanceFrom(order: string[], decided: string) {
    const state = queue ? queueState(queue) : "refill";
    const next = queue
      ? nextAfterDecision(
          order,
          [decided],
          decided,
          queue.proposals.map((p) => p.id),
        )
      : "";
    focusNext = true;
    if (state === "finished") {
      finished = true;
      await navigate(proposalHref("", query), true);
      await tick();
      finishedHeading?.focus({ preventScroll: true });
    } else if (next) await navigate(proposalHref(next, query), true);
    else await navigate(proposalHref("", query), true);
  }
  async function decideBatch(action: string) {
    const ids = [...selected];
    const payload = action === "reject" ? { reason: rejectionReason(choice, reason) } : {};
    let outcomeOf: BatchOutcome | undefined;
    const result = await settleDecision(
      () => api<WriteResult>(`/proposals/${action}`, {}, { ids, ...payload }),
      async (receipt) => {
        const done = batchOutcome(ids, receipt);
        outcomeOf = done;
        intent = "";
        reason = "";
        choice = "";
        selected = done.selected;
        reviewed += done.done.length;
        if (queue) queue = withoutDecided(queue, done.done);
        queue = await fetchQueue();
      },
    );
    if (result.status === "failed") {
      failure = result.error;
      afterFocus = "confirm";
      return;
    }
    const done = outcomeOf!;
    const verb = action === "accept" ? "accepted" : "rejected";
    if (result.refreshError)
      showToast({
        kind: "warning",
        key: "queue-refresh",
        title: "Decision recorded; the queue did not refresh.",
        detail: `${result.refreshError}. Counts may be out of date.`,
        action: { label: "Refresh queue", run: refreshFromToast },
      });
    void refreshPending();
    if (done.failed.length) {
      report = { ...done, verb, total: ids.length };
      afterFocus = "report";
    } else
      showToast({
        key: "decision",
        title: `${decisionVerb(action)} ${done.done.length} proposals`,
        detail: "Details are in Recent decisions.",
        action: { label: "View", run: () => navigate(proposalHref("", new URLSearchParams({ status: "recent" }))) },
      });
    if (desiredId && done.done.includes(desiredId)) await open(desiredId);
  }
  async function refresh() {
    failure = "";
    await load();
    if (desiredId) await open(desiredId);
  }
  /** The toast's action closes the toast, so focus goes to the page rather than to nothing. */
  async function refreshFromToast() {
    await refresh();
    await tick();
    (
      detailHeading ??
      region?.querySelector<HTMLElement>(".review-item") ??
      region?.querySelector<HTMLElement>("h1")
    )?.focus({
      preventScroll: true,
    });
  }
  async function dismissReport() {
    report = null;
    await tick();
    (region?.querySelector<HTMLElement>("[data-primary-decision]") ?? detailHeading)?.focus({ preventScroll: true });
  }
  function go(direction: number) {
    const proposals = queue?.proposals ?? [],
      index = proposals.findIndex((p) => p.id === desiredId);
    const next =
      proposals[
        index < 0
          ? direction > 0
            ? 0
            : proposals.length - 1
          : (index + direction + proposals.length) % proposals.length
      ];
    if (next) select(next.id);
  }
  function keydown(event: KeyboardEvent) {
    if (region?.closest("[hidden]")) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && intent && !busy) {
      event.preventDefault();
      void cancel();
      return;
    }
    if (!shortcutsEnabled || event.repeat || !region?.contains(target)) return;
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.isComposing ||
      target?.closest('input,textarea,select,[contenteditable="true"]')
    )
      return;
    // A decision key pressed while the next proposal is still loading is ignored, never queued.
    if (busy || opening) return;
    switch (event.key.toLowerCase()) {
      case "j":
      case "n":
        event.preventDefault();
        go(1);
        break;
      case "k":
        event.preventDefault();
        go(-1);
        break;
      case "a":
        if (selected.length || current?.status === "pending") {
          event.preventDefault();
          const action = selected.length ? "batch-accept" : "accept";
          intent === action ? void decide() : void begin(action);
        }
        break;
      case "r":
        if (selected.length || current?.status === "pending") {
          event.preventDefault();
          void begin(selected.length ? "batch-reject" : "reject");
        }
        break;
      case "u":
        if (current?.status === "accepted" && current.revertable) {
          event.preventDefault();
          void begin("revert");
        }
        break;
      case "x":
        if (current?.status === "pending") {
          event.preventDefault();
          selected = toggleSelection(selected, current.id, 200);
        }
        break;
      case "[":
      case "]": {
        const all = [
          ...(region?.querySelectorAll<HTMLElement>(".sbs-pane:first-child .drow, .dcol.inline .drow") ?? []),
        ];
        const starts = all.filter(
          (row) => row.matches(".add,.del") && !row.previousElementSibling?.matches(".add,.del"),
        );
        if (!starts.length) break;
        event.preventDefault();
        const at = starts.indexOf(document.activeElement as HTMLElement),
          direction = event.key === "]" ? 1 : -1;
        const next =
          starts[at < 0 ? (direction > 0 ? 0 : starts.length - 1) : (at + direction + starts.length) % starts.length];
        next.tabIndex = -1;
        next.focus();
        break;
      }
    }
  }
</script>

<svelte:window onkeydown={keydown} />
<div class="review-page" data-detail={desiredId ? "" : undefined} bind:this={region}>
  <div class="page-heading">
    <div>
      <h1>Review</h1>
      {#if analyticsReturn}<a class="return-link" href={analyticsReturn}
          ><Icon name="arrow-left" size={16} /> Back to {analyticsReturn.startsWith("/activity/improve")
            ? "improve impact"
            : "activity"}</a
        >{/if}
    </div>
    <button class="btn-quiet" onclick={refresh} disabled={busy || loading}
      ><Icon name="refresh" size={16} /> Refresh queue</button
    >
  </div>
  <div class="review-filters">
    <nav class="tabs" aria-label="Proposal status">
      <a
        class="tab"
        aria-current={status === "pending" ? "page" : undefined}
        href={proposalHref("", new URLSearchParams({ status: "pending" }))}>Pending</a
      ><a
        class="tab"
        aria-current={status === "recent" ? "page" : undefined}
        href={proposalHref("", new URLSearchParams({ status: "recent" }))}>Recent decisions</a
      >
    </nav>
    <label
      >Source<select value={source} onchange={(e) => filter("source", e.currentTarget.value)}
        ><option value="">All processes</option
        >{#each [...new Set([...Object.keys(queue?.bySource ?? {}), ...(source ? [source] : [])])] as s}<option
            value={s}>{s} ({queue?.bySource[s] ?? 0})</option
          >{/each}</select
      ></label
    >
    <label
      >Waiting age<select value={age} onchange={(e) => filter("age", e.currentTarget.value)}
        ><option value="">Any age</option>{#each Object.entries(ageBands) as [key, label]}<option value={key}
            >{label}</option
          >{/each}</select
      ></label
    >
  </div>
  {#if source || age || week || outcome}<p class="muted small active-filters">
      Active filters: {[source, age ? ageBands[age as keyof typeof ageBands] : "", week, outcome]
        .filter(Boolean)
        .join(" · ")} · <a href={proposalHref("", new URLSearchParams({ status }))}>Clear filters</a>
    </p>{/if}
  {#if queueError}<div class="notice notice-fail" role="alert">
      Queue could not refresh: {queueError} <button class="btn-secondary" onclick={load}>Retry queue</button>
    </div>{/if}
  <div class="review review-workspace" data-detail={desiredId ? "" : undefined}>
    <section class="review-list proposal-list" aria-label="Proposals">
      {#if queue}<section class="queue-summary" aria-label="Queue summary">
          <p>
            <strong class="num">{queue.fullCount ?? queue.totalCount}</strong>
            {status === "pending"
              ? "waiting for review"
              : "recent decisions"}{#if source || age || week || outcome}<span class="muted">
                {" "}· {queue.totalCount} match the filters</span
              >{/if}
          </p>
        </section>{/if}

      {#if status === "pending" && queue?.proposals.length}<label class="select-all"
          ><input
            type="checkbox"
            checked={queue.proposals.every((p) => selected.includes(p.id))}
            disabled={busy}
            onchange={(e) => (selected = e.currentTarget.checked ? queue!.proposals.map((p) => p.id) : [])}
          />Select all shown</label
        >{/if}
      {#if loading && !queue}<p class="muted" role="status">Loading proposals…</p>{/if}
      <ul class="review-items">
        {#each queue?.proposals ?? [] as p (p.id)}<li class="review-row" class:active={desiredId === p.id}>
            {#if status === "pending"}<input
                type="checkbox"
                aria-label={`Select ${p.ref}`}
                checked={selected.includes(p.id)}
                disabled={busy}
                onchange={() => (selected = toggleSelection(selected, p.id, 200))}
              />{/if}<a
              class="review-item"
              data-id={p.id}
              title={p.ref}
              aria-current={desiredId === p.id ? "true" : undefined}
              href={proposalHref(p.id, query)}
              ><strong>{title(p)}</strong><span class="queue-location">{conceptLocation(p.ref)}</span><span
                class="queue-meta"
                ><span>{p.isRetire ? "Retirement" : p.source}</span><time
                  title={date(status === "recent" ? (record(p.review).decidedAt ?? p.updatedAt) : p.waitingSince)}
                  >{queueDate(status === "recent" ? (record(p.review).decidedAt ?? p.updatedAt) : p.waitingSince)}</time
                ></span
              >{#if status === "recent"}<span class="small muted"
                  >{p.status}{record(p.review).reason ? ` · ${text(record(p.review).reason)}` : ""}</span
                >{/if}</a
            >
          </li>{/each}
      </ul>
      {#if queue && !queue.proposals.length && !showFinished}<div class="state">
          <h2>
            {source || age
              ? "No proposals match these filters"
              : status === "pending"
                ? "Nothing waiting for review"
                : "No recent decisions"}
          </h2>
          <p class="muted">
            {source || age
              ? "Clear a filter to inspect the rest of the queue."
              : "Decisions appear here after you accept or reject a proposal."}
          </p>
        </div>{/if}
      {#if queue && queue.totalCount > queue.proposals.length}<p class="muted small">
          Showing the first {queue.proposals.length} of {queue.totalCount}. Narrow by source or waiting age.
        </p>{/if}
      <p class="muted small">{reviewed} reviewed this session.</p>
      <div class="queue-utilities">
        {#if queue?.backlog?.length && status === "pending"}<details>
            <summary>By source and age</summary>
            <p class="muted small">Age counts from the last reopening.</p>
            <div class="table-wrap">
              <table>
                <thead
                  ><tr
                    ><th>Process</th>{#each Object.values(ageBands) as label}<th>{label}</th>{/each}</tr
                  ></thead
                ><tbody
                  >{#each queue.backlog as row}<tr
                      ><th>{row.source}</th>{#each Object.keys(ageBands) as band}<td
                          ><a href={proposalHref("", new URLSearchParams({ source: row.source, age: band }))}
                            >{row[band as keyof typeof row]}</a
                          ></td
                        >{/each}</tr
                    >{/each}</tbody
                >
              </table>
            </div>
          </details>{/if}
        <details class="shortcuts">
          <summary>Keyboard shortcuts</summary><label class="check-label"
            ><input type="checkbox" bind:checked={shortcutsEnabled} /> Enable single-key shortcuts for this window</label
          >
          <p class="muted small">
            <kbd>j</kbd>/<kbd>k</kbd> next/previous · <kbd>a</kbd> accept, <kbd>a</kbd> again to confirm · <kbd>r</kbd>
            reject ·
            <kbd>x</kbd> select · <kbd>u</kbd> revert confirmation · <kbd>[</kbd> <kbd>]</kbd> changed blocks ·
            <kbd>Esc</kbd>
            cancel. After accept or reject the next proposal opens. Accept and reject apply to the selection when items are
            selected. Shortcuts work inside Review when you are not typing.
          </p>
        </details>
      </div>
    </section>
    <section class="review-pane inspector" aria-label="Proposal detail">
      <div class="review-scroll" bind:this={scroller}>
        {#if opening}<p role="status" class="muted">Loading proposal…</p>{:else if detailError}<div
            class="notice notice-fail"
            role="alert"
          >
            {detailError}<button class="btn-secondary" onclick={() => open(desiredId)}>Retry proposal</button>
          </div>{:else if detail && current}<ReviewDetail
            {detail}
            {noop}
            {query}
            bind:heading={detailHeading}
          />{:else if showFinished}<ReviewFinished
            {filtered}
            remaining={queue?.fullCount ?? 0}
            {reviewed}
            bind:heading={finishedHeading}
          />{:else}<div class="state welcome">
            <h2>Select a proposal</h2>
            <p>Inspect the source change and evidence before deciding.</p>
          </div>{/if}
      </div>
      {#if current || intent || selected.length || report}<ReviewShelf
          {current}
          {status}
          {intent}
          selectedCount={selected.length}
          {busy}
          {failure}
          {reasonError}
          bind:choice
          bind:reason
          {last}
          {report}
          {query}
          canNext={!!queue?.proposals.some((p) => p.id !== current?.id)}
          bind:el={shelf}
          begin={(action) => void begin(action)}
          cancel={() => void cancel()}
          decide={() => void decide()}
          clearSelection={() => (selected = [])}
          next={() => go(1)}
          openLast={(action) => last && openDecided(last.id, action)}
          {dismissReport}
        />{/if}
    </section>
  </div>
</div>

<style>
  .review-page {
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .page-heading,
  .review-filters {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .page-heading {
    margin-bottom: 0.5rem;
    flex: none;
  }
  .page-heading h1 {
    margin: 0;
  }
  .review-filters {
    justify-content: flex-start;
    margin-bottom: 0.5rem;
    flex: none;
  }
  .review-filters .tabs {
    margin: 0;
  }
  .review-filters label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-s);
  }
  .shortcuts {
    font-size: var(--text-s);
  }
  .shortcuts .check-label {
    display: flex;
    margin-block: 0.75rem;
  }
  .queue-utilities {
    margin-top: 1.5rem;
    font-size: var(--text-s);
  }
  .queue-utilities details {
    margin: 0.5rem 0;
  }
  .queue-meta {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    color: var(--muted);
    font-size: var(--text-xs);
  }
  .queue-meta time {
    white-space: nowrap;
  }
  .queue-location {
    color: var(--muted);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
  .review-workspace {
    display: grid;
    grid-template-columns: minmax(14rem, 24%) minmax(0, 1fr);
    gap: 0;
    align-items: stretch;
    flex: 1;
    min-height: 0;
    margin: 0;
    border-top: 1px solid var(--border);
  }
  .review-workspace > .review-list {
    display: block;
  }
  .return-link {
    display: inline-block;
    font-size: var(--text-s);
    margin-top: 0.5rem;
  }
  .review-list {
    min-width: 0;
    margin: 0;
    padding: 1rem 1rem 1rem 0;
    overflow-y: auto;
  }
  .queue-summary {
    margin: 0 0 1rem;
    font-size: var(--text-s);
  }
  .queue-summary p {
    margin: 0 0 0.5rem;
  }
  .review-pane {
    min-width: 0;
    min-height: 0;
    margin: 0;
    padding: 0;
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }
  .review-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.5rem 1.5rem;
  }
  .review-items {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0;
  }
  .review-row {
    display: flex;
    align-items: start;
    gap: 0.5rem;
    border-radius: 6px;
    margin-bottom: 0.25rem;
  }
  .review-row > input {
    margin-top: 1rem;
  }
  .review-item {
    display: grid;
    gap: 0.5rem;
    padding: 0.875rem 0.5rem;
    min-width: 0;
    width: 100%;
    color: inherit;
    text-decoration: none;
  }
  .review-item:hover,
  .review-row.active {
    background: var(--surface-2);
  }
  .review-item[aria-current] {
    box-shadow: inset 3px 0 var(--accent);
  }
  .review-item strong {
    font-size: 0.875rem;
  }
  .select-all {
    font-size: var(--text-s);
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .state {
    padding: 2rem 1rem;
  }
  .welcome {
    border: 0;
    background: none;
    box-shadow: none;
    text-align: left;
    padding: 2rem 0.5rem;
  }
  @media (max-width: 1050px) {
    .review-workspace {
      grid-template-columns: 14rem minmax(0, 1fr);
    }
    .review-scroll {
      padding: 1.25rem;
    }
  }
  @media (max-width: 850px) {
    .review-workspace {
      display: block;
      min-height: 0;
    }
    .review-list {
      padding-right: 0;
    }
    .review-workspace[data-detail] > .review-list {
      display: none;
    }
    .review-workspace:not([data-detail]) .review-pane {
      border: 0;
    }
    .review-pane {
      border-left: 0;
    }
    .review-scroll {
      padding: 1rem 0 2rem;
      overflow: visible;
    }
    .review-filters {
      gap: 0.75rem;
    }
    .review-filters label {
      display: grid;
      gap: 0.3rem;
      flex: 1;
    }
  }
  @media (max-width: 850px), (max-height: 700px) {
    .review-page[data-detail] > .review-filters,
    .review-page[data-detail] > .active-filters {
      display: none;
    }
  }
  @media (min-width: 851px) and (max-height: 700px) {
    .review-page[data-detail] > .page-heading {
      display: none;
    }
    .review-workspace[data-detail] {
      display: block;
    }
    .review-workspace[data-detail] > .review-list {
      display: none;
    }
    .review-workspace[data-detail] > .review-pane {
      height: 100%;
      border-left: 0;
    }
    .review-scroll {
      padding: 0.75rem 0;
    }
  }
</style>
