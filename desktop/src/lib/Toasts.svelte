<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { dismissToast, holdToast, releaseToast, toasts } from "./state/toasts.svelte";
  import { toastRole, type Toast } from "./toast-model";

  const polite = $derived(toasts.items.filter((t) => toastRole(t.kind) === "status"));
  const urgent = $derived(toasts.items.filter((t) => toastRole(t.kind) === "alert"));

  async function act(toast: Toast) {
    dismissToast(toast.id);
    await toast.action?.run();
  }
</script>

{#snippet list(items: Toast[])}
  {#each items as toast (toast.id)}
    <div
      class="toast toast-{toast.kind}"
      data-toast={toast.kind}
      role="group"
      aria-label="Notification"
      onmouseenter={() => holdToast(toast.id)}
      onmouseleave={() => releaseToast(toast.id)}
      onfocusin={() => holdToast(toast.id)}
      onfocusout={() => releaseToast(toast.id)}
    >
      <div class="toast-text">
        <strong>{toast.title}</strong>
        {#if toast.detail}<span>{toast.detail}</span>{/if}
      </div>
      {#if toast.action}<button type="button" class="btn-secondary" onclick={() => act(toast)}
          >{toast.action.label}</button
        >{/if}
      <button type="button" class="btn-quiet" aria-label="Dismiss notification" onclick={() => dismissToast(toast.id)}
        >Dismiss</button
      >
    </div>
  {/each}
{/snippet}

<!-- The live regions are always in the page, so a toast added to an empty one is announced. Nothing here takes focus. -->
<div class="toasts" aria-label="Notifications">
  <div role="status" aria-live="polite" aria-atomic="false">{@render list(polite)}</div>
  <div role="alert" aria-live="assertive" aria-atomic="false">{@render list(urgent)}</div>
</div>

<style>
  .toasts {
    position: fixed;
    inset-inline: var(--space-4);
    bottom: calc(var(--bottom-inset) + var(--space-4));
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
    pointer-events: none;
  }
  .toasts > div {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-end;
    max-width: min(32rem, 100%);
  }
  .toast {
    pointer-events: auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-float);
    font-size: var(--text-s);
  }
  .toast-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 1 1 12rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .toast-success {
    box-shadow: var(--shadow-float), var(--edge-accent);
  }
  .toast-warning {
    box-shadow: var(--shadow-float), var(--edge-warn);
  }
  .toast-error {
    box-shadow: var(--shadow-float), var(--edge-fail);
  }
</style>
