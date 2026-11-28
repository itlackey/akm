<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { tick } from "svelte";
  import { treeNodes } from "./library-files-model";
  import type { FileListing, TreeNode } from "./library-files-model";
  import type { FileTreeState } from "./file-tree-state.svelte";
  import Icon from "./Icon.svelte";
  let {
    bundles,
    tree,
    label,
    selectedKey = "",
    foldersOnly = false,
    focused = $bindable(""),
    renaming = null,
    dropKey = "",
    onOpen,
    onMenu,
    onRename,
    onBeginRename,
    onCancelRename,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop,
    canDrag,
  }: {
    bundles: string[];
    tree: FileTreeState;
    label: string;
    selectedKey?: string;
    /** The folder picker: only folders and bundles are listed and chosen. */
    foldersOnly?: boolean;
    focused?: string;
    /** The entry being renamed in place. */
    renaming?: { bundle: string; path: string } | null;
    /** The folder a drag is over. */
    dropKey?: string;
    onOpen: (node: TreeNode) => void;
    /** The menu for a node: where the pointer was, or null from the keyboard. */
    onMenu?: (node: TreeNode, point: { x: number; y: number } | null, origin: HTMLElement) => void;
    onRename?: (node: TreeNode, name: string) => void;
    /** F2 on a node. */
    onBeginRename?: (node: TreeNode) => void;
    onCancelRename?: () => void;
    onDragStart?: (node: TreeNode, event: DragEvent) => void;
    onDragEnd?: () => void;
    onDragOver?: (node: TreeNode, event: DragEvent) => void;
    onDrop?: (node: TreeNode, event: DragEvent) => void;
    canDrag?: (node: TreeNode) => boolean;
  } = $props();
  let element = $state<HTMLElement>();
  const shown = $derived(
    foldersOnly
      ? new Map(
          [...tree.listings].map(([key, listing]): [string, FileListing] => [
            key,
            { ...listing, entries: listing.entries.filter((entry) => entry.kind === "directory") },
          ]),
        )
      : tree.listings,
  );
  const nodes = $derived(treeNodes(bundles, shown, tree.expanded));
  const focusKey = $derived(nodes.some((node) => node.key === focused) ? focused : nodes[0]?.key);
  export function container() {
    return element;
  }
  export async function focus(key: string) {
    focused = key;
    await tick();
    const item = [...(element?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])].find(
      (el) => el.dataset.key === key,
    );
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  async function toggle(node: TreeNode) {
    if (node.kind !== "directory" || node.unavailable) return;
    focused = node.key;
    await tree.toggle(node.key, node.bundle, node.path);
    await focus(node.key);
  }
  async function key(event: KeyboardEvent, node: TreeNode) {
    const index = nodes.findIndex((item) => item.key === node.key);
    let target: TreeNode | undefined;
    if (event.key === "ArrowDown") target = nodes[Math.min(nodes.length - 1, index + 1)];
    else if (event.key === "ArrowUp") target = nodes[Math.max(0, index - 1)];
    else if (event.key === "Home") target = nodes[0];
    else if (event.key === "End") target = nodes.at(-1);
    else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (node.kind === "directory") {
        if (!tree.expanded.has(node.key)) await toggle(node);
        else if (nodes[index + 1]?.parentKey === node.key) await focus(nodes[index + 1].key);
      }
      return;
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.kind === "directory" && tree.expanded.has(node.key)) await toggle(node);
      else if (node.parentKey) await focus(node.parentKey);
      return;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(node);
      return;
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      onMenu?.(node, null, event.currentTarget as HTMLElement);
      return;
    } else if (event.key === "F2" && !node.root) {
      event.preventDefault();
      onBeginRename?.(node);
      return;
    }
    if (target) {
      event.preventDefault();
      await focus(target.key);
    }
  }
  function enterRename(input: HTMLInputElement, node: TreeNode) {
    input.focus();
    input.setSelectionRange(0, node.name.includes(".") ? node.name.lastIndexOf(".") : node.name.length);
  }
  function renameKey(event: KeyboardEvent, node: TreeNode) {
    if (event.key === "Enter") {
      event.preventDefault();
      onRename?.(node, (event.currentTarget as HTMLInputElement).value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancelRename?.();
    }
  }
</script>

<div role="tree" aria-label={label} bind:this={element}>
  {#each nodes as node (node.key)}
    {#if renaming && !node.root && renaming.bundle === node.bundle && renaming.path === node.path}
      <div class="tree-rename" style:padding-left={`${8 + (node.level - 1) * 14}px`}>
        <Icon name={node.kind === "directory" ? "folder" : "file"} size={16} /><input
          aria-label={`New name for ${node.name}`}
          value={node.name}
          use:enterRename={node}
          onkeydown={(event) => renameKey(event, node)}
          onblur={() => onCancelRename?.()}
        />
      </div>
    {:else}
      <button
        role="treeitem"
        data-key={node.key}
        class:drop-target={dropKey === node.key}
        draggable={!foldersOnly && canDrag?.(node) ? "true" : undefined}
        aria-level={node.level}
        aria-posinset={node.position}
        aria-setsize={node.setSize}
        aria-selected={selectedKey === node.key}
        aria-expanded={node.kind === "directory" ? tree.expanded.has(node.key) : undefined}
        aria-busy={tree.loading.has(node.key) || undefined}
        aria-haspopup={onMenu ? "menu" : undefined}
        tabindex={focusKey === node.key ? 0 : -1}
        style:padding-left={`${8 + (node.level - 1) * 14}px`}
        onfocus={() => (focused = node.key)}
        onkeydown={(event) => key(event, node)}
        oncontextmenu={(event) => {
          if (!onMenu) return;
          event.preventDefault();
          onMenu(node, { x: event.clientX, y: event.clientY }, event.currentTarget as HTMLElement);
        }}
        ondragstart={(event) => onDragStart?.(node, event)}
        ondragend={() => onDragEnd?.()}
        ondragover={(event) => node.kind === "directory" && onDragOver?.(node, event)}
        ondrop={(event) => node.kind === "directory" && onDrop?.(node, event)}
        onclick={(event) => {
          if ((event.target as Element).closest("[data-expander]")) void toggle(node);
          else onOpen(node);
        }}
        title={node.unavailable || node.path || node.name}
      >
        <span class="twisty" data-expander aria-hidden="true"
          >{#if node.kind === "directory"}<Icon
              name={tree.expanded.has(node.key) ? "chevron-down" : "chevron-right"}
              size={14}
            />{/if}</span
        >
        <Icon name={node.kind === "directory" ? "folder" : "file"} size={16} />
        <span class="node-name">{node.name}</span>{#if node.unavailable}<span
            class="unavailable-dot"
            aria-label="Unavailable"
          ></span>{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  [role="treeitem"] {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 34px;
    padding: 5px var(--space-2);
    border: 0;
    background: none;
    color: var(--text);
    text-align: left;
    font-size: var(--text-2xs);
    font-weight: 400;
    border-radius: var(--radius-xs);
  }
  [role="treeitem"]:hover {
    background: var(--surface);
  }
  [role="treeitem"][aria-selected="true"] {
    background: var(--accent-bg);
    color: var(--accent);
  }
  [role="treeitem"].drop-target {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  [role="treeitem"]:focus-visible {
    outline: var(--focus-ring-accent);
    outline-offset: -2px;
  }
  .tree-rename {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 2px var(--space-2);
  }
  .tree-rename input {
    flex: 1;
    min-width: 0;
    font-size: var(--text-2xs);
    height: 30px;
  }
  .node-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .twisty {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    align-self: stretch;
    flex: none;
    color: var(--muted);
  }
  .unavailable-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
    flex: none;
  }
  @media (max-width: 850px) {
    [role="treeitem"] {
      min-height: 44px;
      font-size: var(--text-s);
    }
    .tree-rename {
      min-height: 44px;
    }
  }
</style>
