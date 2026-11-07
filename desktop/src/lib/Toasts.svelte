<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import Icon from "./Icon.svelte";
  import { dismissToast, holdToast, releaseToast, toasts } from "./state/toasts.svelte";
  import { toastRole, type Toast } from "./toast-model";

  const narrow = new MediaQuery("max-width: 850px");
  // Narrow screens show one success or info toast at a time (the newest); warnings and errors all stay.
  const polite = $derived.by(() => {
    const items = toasts.items.filter((t) => toastRole(t.kind) === "status");
    return narrow.current ? items.slice(-1) : items;
  });
  const urgent = $derived(toasts.items.filter((t) => toastRole(t.kind) === "alert"));
  const icons = { success: "check", warning: "warning", error: "alert" } as const;
  /** The control that had focus before it moved into a toast, which Esc gives it back to. */
  let returnTo: HTMLElement | null = null;

  async function act(toast: Toast) {
    dismissToast(toast.id);
    await toast.action?.run();
  }
  function focusin(event: FocusEvent, toast: Toast) {
    holdToast(toast.id);
    if (event.relatedTarget instanceof HTMLElement && !event.relatedTarget.closest(".toasts"))
      returnTo = event.relatedTarget;
  }
  function keydown(event: KeyboardEvent, toast: Toast) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dismissToast(toast.id);
    const target = returnTo?.isConnected ? returnTo : document.querySelector<HTMLElement>("#main");
    (target ?? document.body).focus({ preventScroll: true });
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
      onfocusin={(event) => focusin(event, toast)}
      onfocusout={() => releaseToast(toast.id)}
      onkeydown={(event) => keydown(event, toast)}
    >
      <span class="toast-icon" aria-hidden="true"
        >{#if toast.kind !== "info"}<Icon name={icons[toast.kind]} size={16} />{/if}</span
      >
      <strong class="toast-title">{toast.title}</strong>
      <button
        type="button"
        class="btn-quiet toast-close"
        aria-label="Dismiss notification"
        onclick={() => dismissToast(toast.id)}><Icon name="close" size={16} /></button
      >
      {#if toast.detail}<span class="toast-body">{toast.detail}</span>{/if}
      {#if toast.action}<button type="button" class="btn-secondary toast-action" onclick={() => act(toast)}
          >{toast.action.label}</button
        >{/if}
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
  /* [icon][title ............ close] / [ ][body] / [ ][action, right-aligned] */
  .toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    column-gap: var(--space-3);
    row-gap: var(--space-1);
    align-items: start;
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
  .toast-icon {
    grid-column: 1;
    padding-block-start: 2px;
    display: flex;
  }
  .toast-title {
    grid-column: 2;
    font-weight: 600;
    overflow-wrap: anywhere;
    padding-block-start: 2px;
  }
  .toast-close {
    grid-column: 3;
    grid-row: 1;
    margin: -6px -6px 0 0;
  }
  .toast-body {
    grid-column: 2 / 4;
    color: var(--muted);
    white-space: pre-line;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .toast-action {
    grid-column: 2 / 4;
    justify-self: end;
    margin-block-start: var(--space-1);
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
      bottom: calc(var(--shelf-h, 0px) + var(--bottom-inset) + 12px + env(safe-area-inset-bottom));
      flex-direction: column;
      align-items: stretch;
    }
    .toast-action {
      justify-self: start;
    }
  }
</style>
