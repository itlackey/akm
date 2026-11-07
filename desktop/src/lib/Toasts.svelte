<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import Icon from "./Icon.svelte";
  import { dismissToast, holdToast, releaseToast, toasts } from "./state/toasts.svelte";
  import { toastRole, type Toast } from "./toast-model";

  const polite = $derived(toasts.items.filter((t) => toastRole(t.kind) === "status"));
  const urgent = $derived(toasts.items.filter((t) => toastRole(t.kind) === "alert"));
  const icons = { success: "check", warning: "warning", error: "alert" } as const;

  async function act(toast: Toast) {
    dismissToast(toast.id);
    await toast.action?.run();
  }
  function keydown(event: KeyboardEvent, toast: Toast) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dismissToast(toast.id);
    (document.querySelector<HTMLElement>("#main") ?? document.body).focus({ preventScroll: true });
  }
</script>

{#snippet list(items: Toast[])}
  {#each items as toast (toast.id)}
    <!-- Esc anywhere inside a toast closes it; the buttons are the interactive controls. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="toast toast-{toast.kind}"
      data-toast={toast.kind}
      role="group"
      aria-label="Notification"
      tabindex="-1"
      onmouseenter={() => holdToast(toast.id)}
      onmouseleave={() => releaseToast(toast.id)}
      onfocusin={() => holdToast(toast.id)}
      onfocusout={() => releaseToast(toast.id)}
      onkeydown={(event) => keydown(event, toast)}
    >
      {#if toast.kind !== "info"}<span class="toast-icon" aria-hidden="true"
          ><Icon name={icons[toast.kind]} size={16} /></span
        >{/if}
      <div class="toast-text">
        <strong>{toast.title}</strong>
        {#if toast.detail}<span class="toast-body">{toast.detail}</span>{/if}
      </div>
      {#if toast.action}<button type="button" class="btn-secondary" onclick={() => act(toast)}
          >{toast.action.label}</button
        >{/if}
      <button type="button" class="btn-quiet" aria-label="Dismiss notification" onclick={() => dismissToast(toast.id)}
        ><Icon name="close" size={16} /></button
      >
    </div>
  {/each}
{/snippet}

<!-- The live regions are always in the page, so a toast added to an empty one is announced. Nothing here takes focus. -->
<section class="toasts" aria-label="Notifications">
  <div role="status" aria-live="polite" aria-atomic="false">{@render list(polite)}</div>
  <div role="alert" aria-atomic="false">{@render list(urgent)}</div>
</section>

<style>
  .toasts {
    position: fixed;
    z-index: 50;
    top: calc(var(--topbar-h) + 12px);
    right: 16px;
    display: flex;
    flex-direction: column-reverse;
    align-items: flex-end;
    gap: var(--space-2);
    max-width: 26rem;
    width: calc(100vw - 32px);
    pointer-events: none;
  }
  .toasts > div {
    display: contents;
  }
  .toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    width: 100%;
    box-sizing: border-box;
    padding: var(--space-3);
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: var(--text-s);
    box-shadow: var(--shadow-float);
  }
  .toast-info {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }
  .toast-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .toast-text strong {
    font-weight: 600;
  }
  .toast-body {
    color: var(--muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .toast :global(button) {
    min-height: 32px;
  }
  .toast-success {
    box-shadow: var(--shadow-float), var(--edge-ok);
  }
  .toast-success .toast-icon {
    color: var(--ok);
  }
  .toast-info {
    box-shadow: var(--shadow-float), var(--edge-accent);
  }
  .toast-warning {
    box-shadow: var(--shadow-float), var(--edge-warn);
  }
  .toast-warning .toast-icon {
    color: var(--warn);
  }
  .toast-error {
    box-shadow: var(--shadow-float), var(--edge-fail);
  }
  .toast-error .toast-icon {
    color: var(--fail);
  }
  @media (max-width: 850px) {
    .toasts {
      top: auto;
      left: 16px;
      right: 16px;
      width: auto;
      max-width: none;
      flex-direction: column;
      align-items: stretch;
      bottom: calc(var(--shelf-h, 0px) + var(--bottom-inset) + 12px + env(safe-area-inset-bottom));
    }
    .toasts > div {
      display: contents;
    }
    .toast {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }
    .toast-info {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .toast > :global(.btn-secondary) {
      grid-column: 2;
      justify-self: start;
      order: 5;
    }
  }
</style>
