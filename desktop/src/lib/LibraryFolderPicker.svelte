<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { libraryRead } from "./library-model";
  export let root: string | null = null;
  export let start = "";
  const dispatch = createEventDispatcher<{ choose: string; close: void }>();
  let dialog: HTMLDialogElement;
  let listing: {
    path: string;
    parent: string | null;
    folders: Array<{ name: string; path: string }>;
    truncated: boolean;
  } | null = null;
  let hidden = false,
    error = "",
    busy = false,
    generation = 0;
  let controller: AbortController;
  const clean = (path: string) => path.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  $: relative = listing
    ? root === null
      ? listing.path
      : clean(listing.path).slice(clean(root).length).replace(/^\//, "")
    : "";
  async function open(path: string) {
    const target = clean(path),
      boundary = root === null ? null : clean(root);
    if (boundary !== null && target !== boundary && !target.startsWith(`${boundary}/`)) return;
    controller?.abort();
    controller = new AbortController();
    const request = ++generation;
    busy = true;
    error = "";
    try {
      const next = await libraryRead<NonNullable<typeof listing>>(
        "/fs/folders",
        { path, hidden: hidden ? "1" : "" },
        controller.signal,
      );
      if (request === generation) listing = next;
    } catch (e) {
      if (request === generation && (e as Error).name !== "AbortError") error = (e as Error).message;
    } finally {
      if (request === generation) busy = false;
    }
  }
  onMount(() => {
    dialog.showModal();
    open(root ?? start);
  });
  onDestroy(() => controller?.abort());
</script>

<dialog
  bind:this={dialog}
  class="folder-picker"
  aria-labelledby="library-folder-heading"
  on:close={() => dispatch("close")}
>
  <form method="dialog" class="folder-picker-body">
    <header>
      <h2 id="library-folder-heading">{root === null ? "Choose a folder" : "Choose a folder in the bundle"}</h2>
      <button class="btn-secondary" aria-label="Close folder picker">Close</button>
    </header>
    <div class="folder-path">
      <button
        type="button"
        class="btn-secondary"
        disabled={!listing?.parent || (root !== null && clean(listing.path) === clean(root)) || busy}
        on:click={() => listing?.parent && open(listing.parent)}>Up</button
      ><code>{root === null ? relative : `${root.split(/[\\/]/).pop()}/${relative}`}</code>
    </div>
    {#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
    <ul class="folder-list" aria-label="Folders">
      {#each listing?.folders ?? [] as folder}<li>
          <button class="folder-row" type="button" disabled={busy} on:click={() => open(folder.path)}
            >▱ {folder.name}</button
          >
        </li>{/each}{#if listing && !listing.folders.length}<li class="muted folder-empty">No folders here.</li>{/if}
    </ul>
    {#if listing?.truncated}<p class="muted small">
        Only the first folders are listed. You can type a relative folder in the editor.
      </p>{/if}
    <footer>
      <label class="check-label"
        ><input type="checkbox" bind:checked={hidden} on:change={() => open(listing?.path ?? root ?? start)} /> Show hidden
        folders</label
      ><button class="btn-secondary">Cancel</button><button
        type="button"
        disabled={!listing || busy}
        on:click={() => dispatch("choose", relative)}>Use this folder</button
      >
    </footer>
  </form>
</dialog>
