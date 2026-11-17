<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { api } from "./client";
  import { libraryRead } from "./library-model";
  import Markdown from "./Markdown.svelte";
  import Properties from "./Properties.svelte";
  import type { FrontmatterRead, Source, TextCheck } from "./types";
  let {
    bundle,
    file,
    returnTo,
    folderHref = "",
  }: { bundle: string; file: string; returnTo: string; folderHref?: string } = $props();
  let source = $state<Source | null>(null),
    error = $state(""),
    properties = $state<FrontmatterRead | null>(null),
    propertiesFailure = $state(""),
    unreadable = $state<TextCheck["unreadable"]>();
  const controller = new AbortController();
  onMount(() => {
    libraryRead<Source>("/desktop/file", { bundle, file }, controller.signal)
      .then(async (value) => {
        source = value;
        // Why akm does not index this file, when it is an asset it could not read: akm's own reason.
        void api<TextCheck>("/documents/check", {}, { bundle, path: file, content: value.content })
          .then((checked) => (unreadable = checked.unreadable))
          .catch(() => undefined);
        try {
          properties = await api<FrontmatterRead>(
            "/documents/frontmatter",
            {},
            { bundle, path: file, content: value.content },
          );
        } catch (cause) {
          if (!controller.signal.aborted) propertiesFailure = (cause as Error).message;
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) error = cause.message;
      });
  });
  onDestroy(() => controller.abort());
</script>

<header>
  <h1>{file.split("/").at(-1)}</h1>
  <div class="actions">
    {#if folderHref}<a href={folderHref}>Back to folder</a>{/if}{#if source?.actions.edit.allowed}<a
        class="btn btn-secondary"
        href={"/library/edit?" + new URLSearchParams({ bundle, file, returnTo })}>Edit file</a
      >{:else if source}<button class="btn btn-secondary" aria-disabled="true" aria-describedby="edit-reason"
        >Edit file</button
      >{/if}
  </div>
</header>
{#if error}<p role="alert">{error}</p>
{:else if source}
  <p class="muted small">
    A file in {bundle}{source.ref ? "" : ", not an indexed asset"}.
  </p>
  {#if !source.actions.edit.allowed}<p class="muted small" id="edit-reason">{source.actions.edit.reason}</p>{/if}
  {#if unreadable && !source.ref}<p class="notice notice-warn reason" role="status">
      Not indexed: akm could not read this as an asset. {unreadable.reason}{unreadable.line
        ? ` (line ${unreadable.line})`
        : ""}
    </p>{/if}
  <Properties {properties} failure={propertiesFailure} />
  {#if properties?.markdown}<Markdown
      content={source.content}
      bodyStart={properties.bodyStart}
      ref={source.ref ?? ""}
    />{:else if properties || propertiesFailure}<pre class="code">{source.content}</pre>{/if}
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
  /* The page's heading, at the size it had as a second-level heading. */
  h1 {
    margin: 0;
    font-size: var(--text-l);
    line-height: inherit;
    letter-spacing: var(--tracking-snug);
    overflow-wrap: anywhere;
  }
  .reason {
    white-space: pre-line;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
