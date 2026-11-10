<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { api } from "./client";
  import SensitiveEditor from "./SensitiveEditor.svelte";
  import Icon from "./Icon.svelte";
  import type { SensitiveInfo, SensitiveValue } from "./types";
  let {
    ref = "",
    bundle = "",
    file = "",
    onChanged,
  }: {
    ref?: string;
    bundle?: string;
    file?: string;
    /** The file was rewritten or deleted. */
    onChanged?: () => void;
  } = $props();
  let info = $state<SensitiveInfo | null>(null);
  let content = $state<string | null>(null),
    busy = $state(false),
    error = $state(""),
    generation = 0;
  let editing = $state(false),
    deleting = $state(false),
    deleted = $state(false),
    notice = $state(""),
    warnings = $state<string[]>([]);
  const selector = (): Record<string, string> => (ref ? { ref } : { bundle, file });
  function hide() {
    generation++;
    content = null;
    busy = false;
  }
  afterNavigate(() => {
    hide();
    editing = false;
    deleting = false;
  });
  onDestroy(hide);
  async function load() {
    try {
      info = await api("/desktop/sensitive", selector());
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
  onMount(load);
  async function remove() {
    if (!info) return;
    busy = true;
    error = "";
    try {
      const result = await api<{ warnings: string[] }>(
        "/desktop/sensitive/delete",
        {},
        { bundle: info.bundle, file: info.location.path, revision: info.revision },
      );
      hide();
      deleted = true;
      warnings = result.warnings;
      onChanged?.();
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      busy = false;
    }
  }
  async function saved(result: { warnings: string[] }) {
    editing = false;
    hide();
    notice = "Changes saved.";
    warnings = result.warnings;
    await load();
    onChanged?.();
  }
  async function show() {
    const request = ++generation;
    busy = true;
    error = "";
    try {
      const result = await api<SensitiveValue>("/desktop/sensitive/reveal", {}, selector());
      if (generation === request) content = result.content;
    } catch (cause) {
      if (generation === request) error = (cause as Error).message;
    } finally {
      if (generation === request) busy = false;
    }
  }
</script>

<section class="sensitive-reader" aria-label="Protected file">
  {#if deleted && info}<h1>File deleted</h1>
    <p class="muted">{info.location.path}</p>
    <a
      class="btn btn-secondary"
      href={"/library/files?" + new URLSearchParams({ bundle: info.bundle, path: info.location.parent })}
      >Back to folder</a
    >
  {:else if editing && info}<SensitiveEditor
      bundle={info.bundle}
      file={info.location.path}
      type={info.type}
      onSaved={saved}
      onCancel={() => {
        editing = false;
        hide();
      }}
    />
  {:else if info}
    <header>
      <div>
        <h1>{info.name}</h1>
        <p class="muted small">{info.bundle} · {info.type === "env" ? "Environment file" : "Secret"}</p>
      </div>
      <div class="file-actions">
        <button
          class="btn-secondary"
          disabled={busy}
          aria-pressed={content !== null}
          onclick={() => (content === null ? show() : hide())}
          >{busy ? "Opening…" : content === null ? "Show" : "Hide"}</button
        >
        {#if info.writable}<button
            class="btn-secondary"
            disabled={busy}
            onclick={() => {
              hide();
              editing = true;
              notice = "";
            }}><Icon name="edit" size={16} />Edit</button
          ><button
            class="btn-secondary"
            disabled={busy}
            onclick={() => {
              hide();
              deleting = true;
            }}>Delete…</button
          >{/if}
      </div>
    </header>
    {#if deleting}<section class="notice" aria-label="Delete file">
        <h3>Delete this file?</h3>
        <p class="mono wrap">{info.path}</p>
        <p>This removes the file and its sensitive marker. There is no Undo; existing Git history is unchanged.</p>
        <div class="btn-row">
          <button class="btn-secondary" disabled={busy} onclick={() => (deleting = false)}>Keep file</button><button
            class="btn-danger"
            disabled={busy}
            onclick={remove}>Delete file</button
          >
        </div>
      </section>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if content === null}<div class="masked" aria-label="Values masked">••••••••</div>
      <p class="muted small">Values stay hidden until you choose Show.</p>
    {:else}<pre class="code secret-content">{content}</pre>{/if}
  {:else if !error}<p role="status">Opening file…</p>{/if}
  {#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
  {#each warnings as warning}<p class="notice notice-warn">{warning}</p>{/each}
</section>

<style>
  .sensitive-reader {
    max-width: 960px;
  }
  .sensitive-reader header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .file-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* The page's heading, with the line height and spacing it had as a second-level heading. */
  .sensitive-reader h1 {
    margin: 0;
    font-size: 24px;
    line-height: inherit;
    letter-spacing: var(--tracking-snug);
  }
  .sensitive-reader header p {
    margin: 10px 0 0;
  }
  .masked {
    padding: 24px;
    background: var(--surface-subtle, var(--bg));
    border-radius: 8px;
    font-size: 24px;
    letter-spacing: 4px;
  }
  .secret-content {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 24px;
    line-height: 1.6;
  }
</style>
