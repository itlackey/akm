<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { api } from "./client";
  import { ancestorPaths, directoryKey } from "./library-files-model";
  import type { FileRequest, TreeNode } from "./library-files-model";
  import { FileTreeState } from "./file-tree-state.svelte";
  import FileTree from "./FileTree.svelte";
  let {
    request,
    bundles,
    onDone,
    onCancel,
  }: {
    request: FileRequest;
    bundles: string[];
    onDone: (
      request: FileRequest,
      result: Record<string, unknown>,
      destination: { bundle: string; path: string },
    ) => void;
    onCancel: () => void;
  } = $props();
  const tree = new FileTreeState();
  let dialog = $state<HTMLDialogElement>(),
    destination = $state(untrack(() => request.destination)),
    name = $state(
      untrack(() => {
        const copy = request.actions.copy;
        return request.kind === "copy" && copy.allowed && copy.as ? copy.as.split("/").at(-1)! : request.name;
      }),
    ),
    focused = $state(""),
    busy = $state(false),
    error = $state("");
  const picking = $derived(request.kind === "move" || request.kind === "copy");
  const key = $derived(directoryKey(destination.bundle, destination.path));
  const listing = $derived(tree.listings.get(key));
  const own = $derived(
    request.kind === "copy"
      ? request.actions.copy
      : request.kind === "delete"
        ? request.actions.delete
        : request.actions.move,
  );
  // akm's sentence for what stops this: the entry, then the folder it goes into.
  const refusal = $derived(
    !own.allowed
      ? own.reason
      : request.kind !== "delete" && listing && !listing.place.allowed
        ? listing.place.reason
        : "",
  );
  // What akm will copy, said before it happens: a skill's manifest copies as the skill's folder.
  const copiesAs = $derived(
    request.kind === "copy" && request.actions.copy.allowed ? request.actions.copy.as : undefined,
  );
  const title = $derived(
    {
      move: `Move ${request.name}`,
      copy: `Copy ${request.name}`,
      drop: `Move ${request.name} into ${destination.path.split("/").at(-1) || destination.bundle}?`,
      delete: `Delete ${request.name}?`,
    }[request.kind],
  );
  onMount(() => {
    dialog?.showModal();
    if (request.kind !== "delete") {
      for (const path of ancestorPaths(request.destination.path))
        void tree.open(directoryKey(request.destination.bundle, path), request.destination.bundle, path);
      focused = key;
    }
  });
  onDestroy(() => tree.abort());
  function choose(node: TreeNode) {
    if (node.kind !== "directory") return;
    destination = { bundle: node.bundle, path: node.path };
    void tree.load(node.bundle, node.path);
  }
  async function confirm() {
    if (busy || refusal) return;
    busy = true;
    error = "";
    try {
      const result =
        request.kind === "delete"
          ? await api<Record<string, unknown>>(
              "/desktop/files/delete",
              {},
              { bundle: request.bundle, path: request.path },
            )
          : await api<Record<string, unknown>>(
              `/desktop/files/${request.kind === "copy" ? "copy" : "move"}`,
              {},
              {
                bundle: request.bundle,
                from: request.path,
                toBundle: destination.bundle,
                folder: destination.path,
                name: request.kind === "copy" ? name : request.name,
              },
            );
      onDone(request, result, destination);
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  class="leave-editor-dialog file-dialog"
  bind:this={dialog}
  aria-labelledby="file-dialog-title"
  oncancel={onCancel}
>
  <h2 id="file-dialog-title">{title}</h2>
  {#if request.kind === "delete"}
    <p>
      {request.actions.delete.allowed ? "This cannot be undone." : "This cannot be deleted."}
    </p>
  {:else if request.kind === "drop"}
    <p>The file is renamed on disk into that folder; its history goes with it.</p>
  {:else}
    <p id="file-dialog-where">Choose the folder it goes into.</p>
    {#if copiesAs}<p class="notice">This copies the whole folder {copiesAs}, not only {request.name}.</p>{/if}
    <div class="picker" aria-describedby="file-dialog-where">
      <FileTree {bundles} {tree} label="Folders" selectedKey={key} foldersOnly bind:focused onOpen={choose} />
    </div>
    <p class="muted small">Into: <strong>{destination.bundle}/{destination.path}</strong></p>
    {#if request.kind === "copy"}<label class="copy-name">Name of the copy<input bind:value={name} /></label>{/if}
  {/if}
  {#if refusal}<p class="notice" id="file-dialog-reason">{refusal}</p>{/if}
  {#if error}<p class="notice notice-fail" role="alert">{error}</p>{/if}
  <div class="btn-row dialog-actions">
    <button class="btn-secondary" type="button" onclick={onCancel}>Cancel</button><button
      class={request.kind === "delete" ? "btn-danger" : ""}
      type="button"
      aria-disabled={busy || refusal ? "true" : undefined}
      aria-busy={busy || undefined}
      aria-describedby={refusal ? "file-dialog-reason" : undefined}
      onclick={confirm}
      >{busy
        ? "Working…"
        : request.kind === "delete"
          ? "Delete"
          : request.kind === "copy"
            ? "Copy here"
            : "Move here"}</button
    >
  </div>
</dialog>

<style>
  .file-dialog {
    inline-size: min(34rem, calc(100vw - 2rem));
  }
  .picker {
    max-height: 40vh;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px;
    margin-block: 8px;
  }
  .copy-name {
    display: grid;
    gap: 6px;
    font-size: 13px;
    font-weight: 550;
  }
  h2 {
    overflow-wrap: anywhere;
  }
</style>
