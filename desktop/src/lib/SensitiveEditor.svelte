<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy, tick } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { api, saveContent } from "./client";
  import { navigate } from "./navigation";
  import { setUnsaved } from "./upstream/lib.js";
  import type { Bundle } from "./types";
  export let bundle = "";
  export let file = "";
  export let type: "env" | "secret" = "env";
  export let creating = false;
  export let bundles: Bundle[] = [];
  const dispatch = createEventDispatcher<{
    saved: { bundle: string; file: string; ref: string; warnings: string[] };
    cancel: void;
  }>();
  let name = "",
    content = "",
    original = "",
    revision = "",
    busy = false,
    loaded = false,
    dirty = false,
    error = "",
    alive = true;
  let pending = "",
    pendingDelta = 0,
    approved = "",
    dialog: HTMLDialogElement,
    editor: HTMLTextAreaElement;
  $: writable = bundles.filter((item) => item.enabled && item.writable);
  $: noun = type === "env" ? "environment file" : "secret";
  function changed() {
    dirty = true;
    setUnsaved(true);
  }
  beforeNavigate((event) => {
    if (approved && event.to?.url.href === approved) {
      approved = "";
      return;
    }
    if (!dirty && !busy) return;
    event.cancel();
    if (busy) {
      error = "Wait for the current file operation to finish.";
      return;
    }
    if (event.to && !event.willUnload && !dialog.open) {
      pending = event.to.url.href;
      pendingDelta = event.type === "popstate" ? (event.delta ?? 0) : 0;
      dialog.showModal();
    }
  });
  function cancel() {
    if (dirty) {
      pending = "";
      dialog.showModal();
    } else dispatch("cancel");
  }
  async function discard() {
    dirty = false;
    setUnsaved(false);
    content = "";
    original = "";
    dialog.close();
    if (pending) {
      approved = pending;
      // Kit restored the cancelled traversal. Retry it, rather than inserting
      // another history entry and losing the user's Forward destination.
      if (pendingDelta) history.go(pendingDelta);
      else await navigate(pending);
    } else dispatch("cancel");
  }
  async function save() {
    busy = true;
    setUnsaved(true);
    error = "";
    const destination = creating
      ? `${type === "env" ? "env" : "secrets"}/${name.trim()}${type === "env" && !name.trim().endsWith(".env") ? ".env" : ""}`
      : file;
    try {
      const result = await api<{ bundle: string; file: string; ref: string; warnings: string[] }>(
        "/desktop/sensitive/" + (creating ? "create" : "save"),
        {},
        {
          bundle,
          file: destination,
          content: creating ? content : saveContent(original, content),
          ...(creating ? {} : { revision }),
        },
      );
      if (!alive) return;
      dirty = false;
      setUnsaved(false);
      content = "";
      original = "";
      dispatch("saved", result);
    } catch (cause) {
      if (alive) error = (cause as Error).message;
    } finally {
      if (alive) {
        busy = false;
        setUnsaved(dirty);
      }
    }
  }
  onMount(async () => {
    busy = true;
    try {
      if (creating) {
        bundle = writable.find((item) => item.name === bundle)?.name ?? writable[0]?.name ?? "";
      } else {
        const result = await api<{ content: string; revision: string }>(
          "/desktop/sensitive/reveal",
          {},
          { bundle, file },
        );
        if (!alive) return;
        original = result.content;
        content = original.replace(/\r\n?/g, "\n");
        revision = result.revision;
      }
      loaded = true;
      await tick();
      editor?.focus();
    } catch (cause) {
      if (alive) error = (cause as Error).message;
    } finally {
      if (alive) busy = false;
    }
  });
  onDestroy(() => {
    alive = false;
    content = "";
    original = "";
    setUnsaved(false);
  });
</script>

<section class="sensitive-editor" aria-label={creating ? `Create ${noun}` : `Edit ${noun}`}>
  <header>
    <h2>{creating ? `New ${noun}` : `Edit ${file.split("/").at(-1)}`}</h2>
    <p class="muted small">Edits stay in memory only. Saving follows this bundle’s Git policy.</p>
  </header>
  {#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
  {#if loaded}<form on:submit|preventDefault={save}>
      {#if creating}<div class="form-grid">
          <label
            >Bundle<select bind:value={bundle} disabled={busy} on:change={changed}
              >{#each writable as item}<option value={item.name}>{item.name}</option>{/each}</select
            ></label
          ><label
            >File name<input
              bind:value={name}
              on:input={changed}
              required
              disabled={busy}
              autocomplete="off"
              placeholder={type === "env" ? "service.env" : "api-key"}
            /></label
          >
        </div>{/if}
      <label class="field"
        >File contents<textarea
          bind:this={editor}
          bind:value={content}
          on:input={changed}
          disabled={busy}
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"></textarea></label
      >
      <footer>
        <span class="muted small" role="status">{dirty ? "Unsaved changes" : "No unsaved changes"}</span>
        <div class="btn-row">
          <button type="button" class="btn-secondary" disabled={busy} on:click={cancel}>Cancel</button><button
            disabled={busy || !bundle || (creating ? !name.trim() : !dirty)}
            >{busy ? "Saving…" : creating ? "Create file" : "Save changes"}</button
          >
        </div>
      </footer>
    </form>{:else if busy}<p role="status">Opening editor…</p>{:else}<button
      class="btn-secondary"
      on:click={() => dispatch("cancel")}>Back to file</button
    >{/if}
</section>
<dialog bind:this={dialog} aria-labelledby="sensitive-discard-title" on:cancel={() => (pending = "")}>
  <h2 id="sensitive-discard-title">Discard these unsaved changes?</h2>
  <p>Secret and environment edits are not saved as drafts.</p>
  <div class="btn-row">
    <button
      class="btn-secondary"
      on:click={() => {
        dialog.close();
        pending = "";
        editor?.focus();
      }}>Keep editing</button
    ><button class="btn-danger" on:click={discard}>Discard changes</button>
  </div>
</dialog>

<style>
  .sensitive-editor {
    max-width: 960px;
  }
  .sensitive-editor h2 {
    font-size: 24px;
    margin: 0;
  }
  .sensitive-editor header {
    margin-bottom: 24px;
  }
  .sensitive-editor header p {
    margin-top: 10px;
  }
  .sensitive-editor form {
    display: grid;
    gap: 24px;
  }
  .sensitive-editor textarea {
    font-family: var(--mono);
    min-height: 320px;
    resize: vertical;
    line-height: 1.6;
  }
  .sensitive-editor footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .sensitive-editor .btn-row {
    margin: 0;
  }
  dialog {
    max-width: 460px;
    width: calc(100vw - 32px);
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.4);
  }
  dialog p {
    line-height: 1.6;
  }
  dialog .btn-row {
    justify-content: flex-end;
  }
</style>
