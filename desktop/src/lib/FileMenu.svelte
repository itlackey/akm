<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount } from "svelte";
  import { newFileLabel } from "./library-files-model";
  import type { FileActions, FileListing, Verdict } from "./library-files-model";
  let {
    name,
    actions,
    folder,
    at,
    origin,
    native = false,
    onChoose,
    onClose,
  }: {
    name: string;
    /** What akm accepts doing to the entry; none for a bundle's root. */
    actions?: FileActions;
    /** The folder's own listing when the entry is a folder or a bundle's root: what a new file or folder there would be. */
    folder?: FileListing;
    at: { x: number; y: number } | null;
    origin: HTMLElement;
    /** The Electron shell can show a file in the system file manager. */
    native?: boolean;
    onChoose: (action: "new-file" | "new-folder" | "rename" | "move" | "copy" | "retire" | "delete" | "reveal") => void;
    onClose: () => void;
  } = $props();
  type Item = { id: Parameters<typeof onChoose>[0]; label: string; verdict: Verdict };
  const allowed: Verdict = { allowed: true };
  const items = $derived<Item[]>([
    ...(folder
      ? [
          { id: "new-file", label: newFileLabel(folder.newFile), verdict: folder.newFile },
          { id: "new-folder", label: "New folder", verdict: folder.place },
        ]
      : []),
    ...(actions
      ? [
          { id: "rename", label: "Rename", verdict: actions.move },
          { id: "move", label: "Move to…", verdict: actions.move },
          { id: "copy", label: "Copy to…", verdict: actions.copy },
          { id: "retire", label: "Retire", verdict: actions.retire },
          { id: "delete", label: "Delete", verdict: actions.delete },
        ]
      : []),
    ...(native && actions ? [{ id: "reveal", label: "Reveal in file manager", verdict: allowed }] : []),
  ] as Item[]);
  let menu = $state<HTMLElement>();
  const position = (() => {
    const box = origin.getBoundingClientRect();
    return at ?? { x: box.left + 24, y: box.bottom };
  })();
  onMount(() => {
    menu?.showPopover();
    menu?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const edge = menu?.getBoundingClientRect();
    if (edge && menu) {
      menu.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - edge.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - edge.height - 8))}px`;
    }
  });
  function key(event: KeyboardEvent) {
    const buttons = [...(menu?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      buttons[(index + buttons.length) % buttons.length]?.focus();
    };
    if (event.key === "ArrowDown") move(current + 1);
    else if (event.key === "ArrowUp") move(current - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (event.key === "Tab") onClose();
  }
  function choose(item: Item) {
    if (!item.verdict.allowed) return;
    onChoose(item.id);
  }
</script>

<div
  class="file-menu"
  popover="auto"
  role="menu"
  aria-label={`Actions for ${name}`}
  tabindex="-1"
  bind:this={menu}
  style:left={`${position.x}px`}
  style:top={`${position.y}px`}
  onkeydown={key}
  ontoggle={(event) => (event as ToggleEvent).newState === "closed" && onClose()}
>
  {#each items as item (item.id)}
    <button
      role="menuitem"
      type="button"
      aria-disabled={item.verdict.allowed ? undefined : "true"}
      aria-describedby={item.verdict.allowed ? undefined : `menu-reason-${item.id}`}
      onclick={() => choose(item)}
      ><span>{item.label}</span>{#if !item.verdict.allowed}<span class="menu-reason" id={`menu-reason-${item.id}`}
          >{item.verdict.reason}</span
        >{/if}</button
    >
  {/each}
</div>

<style>
  .file-menu {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 4px;
    min-width: 220px;
    max-width: min(360px, calc(100vw - 16px));
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  }
  [role="menuitem"] {
    display: grid;
    gap: 2px;
    width: 100%;
    min-height: 36px;
    padding: 6px 10px;
    border: 0;
    background: none;
    color: var(--text);
    text-align: left;
    font-size: 13px;
    font-weight: 500;
    border-radius: 4px;
  }
  [role="menuitem"]:hover,
  [role="menuitem"]:focus-visible {
    background: var(--accent-bg);
  }
  [role="menuitem"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  [role="menuitem"][aria-disabled="true"] {
    color: var(--muted);
    cursor: not-allowed;
  }
  .menu-reason {
    font-size: 12px;
    font-weight: 400;
    white-space: normal;
  }
</style>
