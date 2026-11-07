<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import Icon from "./Icon.svelte";
  import {
    decisionVerb,
    proposalHref,
    rejectionChoices,
    type BatchOutcome,
    type LastDecision,
    type ReviewProposal,
  } from "./review-model";
  import { title } from "./client";

  let {
    current,
    status,
    intent,
    selectedCount,
    busy,
    failure,
    reasonError,
    choice = $bindable(),
    reason = $bindable(),
    last,
    report,
    query,
    canNext,
    el = $bindable(),
    begin,
    cancel,
    decide,
    clearSelection,
    next,
    openLast,
    dismissReport,
  }: {
    current: ReviewProposal | undefined;
    status: string;
    intent: string;
    selectedCount: number;
    busy: boolean;
    failure: string;
    reasonError: string;
    choice: string;
    reason: string;
    last: LastDecision | null;
    report: (BatchOutcome & { verb: string; total: number }) | null;
    query: URLSearchParams;
    canNext: boolean;
    el?: HTMLElement;
    begin: (action: string) => void;
    cancel: () => void;
    decide: () => void;
    clearSelection: () => void;
    next: () => void;
    openLast: (action: "revert" | "reopen") => void;
    dismissReport: () => void;
  } = $props();

  const batch = $derived(intent.startsWith("batch-"));
  const action = $derived(intent.replace("batch-", ""));
  const rejecting = $derived(action === "reject");
  const questions: Record<string, [string, string]> = {
    accept: [
      "Accept this proposal?",
      "Writes through AKM; Git-backed bundles commit and may push per their Git policy.",
    ],
    reject: ["Reject this proposal?", "It can be reopened later while its target is valid."],
    reopen: ["Reopen this proposal?", "It returns to the pending queue if its target is still valid."],
    revert: [
      "Revert this accepted change?",
      "Restores the backup kept at acceptance. AKM refuses if the asset changed since.",
    ],
  };
  const question = $derived(
    batch
      ? action === "accept"
        ? [
            `Accept ${selectedCount} selected proposals?`,
            "Each is written separately; some can succeed while others fail.",
          ]
        : [`Reject ${selectedCount} selected proposals?`, "The reason is recorded for each."]
      : (questions[action] ?? ["", ""]),
  );
  const verbs: Record<string, [string, string]> = {
    accept: ["Confirm accept", "Accepting…"],
    reject: ["Confirm reject", "Rejecting…"],
    reopen: ["Confirm reopen", "Reopening…"],
    revert: ["Confirm revert", "Reverting…"],
  };
  const confirmLabel = $derived(busy ? verbs[action]?.[1] : `${verbs[action]?.[0]}${batch ? ` ${selectedCount}` : ""}`);
  const nextLabel = $derived(status === "pending" ? "pending" : "decision");
</script>

<footer
  class="decision-shelf"
  class:rejecting={!!intent && rejecting}
  aria-label="Proposal decision"
  aria-busy={busy}
  bind:this={el}
>
  {#if report}<section class="notice notice-warn report" role="alert">
      <h3 tabindex="-1" data-report>
        {report.done.length} of {report.total}
        {report.verb}. {report.failed.length} failed and {report.failed.length === 1 ? "remains" : "remain"} selected.
      </h3>
      <ul class="plain">
        {#each report.failed as f}<li>
            <span class="badge" data-tone="fail">Failed</span>
            <a href={proposalHref(f.id, query)}>{f.ref ?? f.id}</a> — {f.error}{#if f.code}{" "}<code>{f.code}</code
              >{/if}
          </li>{/each}
      </ul>
      <button type="button" class="btn-quiet" onclick={dismissReport}>Dismiss</button>
    </section>{/if}
  {#if failure}<div class="notice notice-fail" role="alert">
      <strong>The decision was not recorded.</strong>
      {failure}
    </div>{/if}
  {#if intent && rejecting}<div class="reason-block">
      <div class="reason-chips" role="group" aria-labelledby="why-reject">
        <span id="why-reject" class="legend">Why reject?</span>
        <div class="segmented">
          {#each rejectionChoices as chip}<label
              ><input type="radio" name="reject-choice" value={chip} bind:group={choice} disabled={busy} /><span
                >{chip}</span
              ></label
            >{/each}
        </div>
      </div>
      <label
        >Details<textarea
          bind:value={reason}
          rows="2"
          maxlength="2000"
          disabled={busy}
          aria-describedby={reasonError ? "reason-hint reason-error" : "reason-hint"}
          aria-invalid={reasonError ? "true" : undefined}></textarea></label
      >
      <p class="muted small" id="reason-hint">
        Optional when a reason is chosen above. Required for Other. At most 2000 characters in total.
      </p>
      {#if reasonError}<p class="field-error" id="reason-error" role="alert">{reasonError}</p>{/if}
    </div>{/if}
  <div class="shelf-row">
    {#if intent}
      <div class="shelf-left" aria-label="Confirm decision" role="group">
        <strong>{question[0]}</strong>
        <span class="muted small helper">{question[1]}</span>
      </div>
      <div class="btn-row">
        <button type="button" class="btn-secondary" disabled={busy} onclick={cancel}>Cancel</button><button
          type="button"
          class="confirm"
          data-confirm
          disabled={busy}
          onclick={decide}
          >{#if busy}<span class="spinner" aria-hidden="true"></span>
          {/if}{confirmLabel}</button
        >
      </div>
    {:else if selectedCount}
      <div class="shelf-left">
        <strong>{selectedCount} selected</strong>
        <button type="button" class="btn-quiet" disabled={busy} onclick={clearSelection}>Clear selection</button>
      </div>
      <div class="btn-row">
        <button type="button" class="btn-secondary" disabled={busy} onclick={() => begin("batch-reject")}
          >Reject selected…</button
        ><button type="button" disabled={busy} data-primary-decision onclick={() => begin("batch-accept")}
          >Accept selected…</button
        >
      </div>
    {:else if current}
      <div class="shelf-left muted">
        {#if last}<span class="last"
            ><span class="last-text" title={`${last.title} — ${last.ref}`}
              >Last: {decisionVerb(last.action)} “{last.title}”</span
            >{#if last.action === "accept" && last.revertable}
              · <button type="button" class="link-button" disabled={busy} onclick={() => openLast("revert")}
                >Undo…</button
              >{:else if last.action === "reject"}
              · <button type="button" class="link-button" disabled={busy} onclick={() => openLast("reopen")}
                >Reopen…</button
              >{/if}</span
          >{/if}
      </div>
      <div class="btn-row">
        <button type="button" class="btn-quiet" disabled={busy || !canNext} onclick={next}
          >Next<span class="next-context">&nbsp;{nextLabel}</span><Icon name="arrow-right" size={16} /></button
        >
        {#if current.status === "pending"}<button
            type="button"
            class="btn-secondary"
            disabled={busy}
            data-decision="reject"
            onclick={() => begin("reject")}>Reject…</button
          ><button
            type="button"
            data-primary-decision
            disabled={busy}
            data-decision="accept"
            onclick={() => begin("accept")}>Accept…</button
          >{:else if current.status === "rejected"}<button
            type="button"
            data-primary-decision
            disabled={busy}
            data-decision="reopen"
            onclick={() => begin("reopen")}>Reopen…</button
          >{:else if current.status === "accepted" && current.revertable}<button
            type="button"
            data-primary-decision
            disabled={busy}
            data-decision="revert"
            onclick={() => begin("revert")}>Revert…</button
          >{/if}
      </div>
    {/if}
  </div>
</footer>

<style>
  .decision-shelf {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-top: 1px solid var(--border);
    padding: var(--space-3) var(--space-5);
    background: var(--surface);
    max-height: 45%;
    overflow-y: auto;
  }
  .shelf-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    position: sticky;
    bottom: 0;
    background: var(--surface);
  }
  .shelf-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-3);
    font-size: var(--text-s);
  }
  .shelf-left strong {
    color: var(--text);
  }
  .last {
    display: flex;
    align-items: baseline;
    gap: var(--space-1);
    min-width: 0;
  }
  .last-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link-button {
    background: none;
    border: 0;
    padding: 0;
    min-height: 0;
    color: var(--link);
    text-decoration: underline;
    font: inherit;
    cursor: pointer;
    box-shadow: none;
  }
  .btn-row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: nowrap;
    margin: 0;
  }
  .confirm {
    min-width: 9rem;
  }
  [data-primary-decision] {
    min-width: 6.5rem;
  }
  .decision-shelf.rejecting {
    max-height: 60%;
  }
  .reason-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }
  .legend {
    font-weight: 600;
  }
  .reason-block {
    display: grid;
    gap: var(--space-2);
    font-size: var(--text-s);
  }
  .reason-block textarea {
    width: 100%;
    box-sizing: border-box;
  }
  .reason-block p {
    margin: 0;
  }
  .report h3 {
    font-size: var(--text-m);
    margin: 0 0 var(--space-2);
  }
  .report li {
    font-size: var(--text-s);
    overflow-wrap: anywhere;
  }
  .notice {
    margin: 0;
  }
  @media (max-width: 850px), (max-height: 700px) {
    .decision-shelf {
      position: sticky;
      bottom: var(--bottom-inset);
      z-index: 2;
      padding: var(--space-3);
      max-height: 50dvh;
    }
    .decision-shelf.rejecting {
      max-height: 60dvh;
    }
    .shelf-row {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-2);
    }
    .shelf-left {
      flex-wrap: nowrap;
    }
    .btn-row > button {
      flex: 1;
      min-width: 0;
      padding-inline: var(--space-2);
    }
    .btn-row {
      width: 100%;
    }
    .confirm {
      min-width: 0;
    }
  }
  @media (max-width: 520px) {
    .helper {
      display: none;
    }
  }
  @media (max-width: 850px) {
    .next-context {
      display: none;
    }
  }
</style>
