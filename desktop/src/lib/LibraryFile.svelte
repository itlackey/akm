<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { libraryRead } from "./library-model";
  import Markdown from "./Markdown.svelte";
  import type { Source } from "./types";
  let {
    bundle,
    file,
    returnTo,
    folderHref = "",
  }: { bundle: string; file: string; returnTo: string; folderHref?: string } = $props();
  let source = $state<Source | null>(null),
    error = $state("");
  const controller = new AbortController();
  onMount(() => {
    libraryRead<Source>("/desktop/file", { bundle, file }, controller.signal)
      .then((value) => (source = value))
      .catch((cause) => {
        if (!controller.signal.aborted) error = cause.message;
      });
  });
  onDestroy(() => controller.abort());
</script>

<header>
  <h2>{file.split("/").at(-1)}</h2>
  <div class="actions">
    {#if folderHref}<a href={folderHref}>Back to folder</a>{/if}{#if source?.writable}<a
        class="btn btn-secondary"
        href={"/library/edit?" + new URLSearchParams({ bundle, file, returnTo })}>Edit file</a
      >{/if}
  </div>
</header>
{#if error}<p role="alert">{error}</p>
{:else if source}
  <p class="muted small">
    A file in {bundle}{source.ref ? "" : ", not an indexed asset"}{source.writable ? "" : " · Read only"}.
  </p>
  {#if source.markdown}<Markdown content={source.content} ref={source.ref ?? ""} />{:else}<pre
      class="code">{source.content}</pre>{/if}
{:else}<p role="status">Opening file…</p>{/if}

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  h2 {
    margin: 0;
    overflow-wrap: anywhere;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
