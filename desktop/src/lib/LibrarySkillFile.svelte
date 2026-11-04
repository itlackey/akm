<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { libraryRead } from './library-model';
  import Markdown from './Markdown.svelte';
  import type { Source } from './types';
  export let bundle: string;
  export let file: string;
  export let returnTo: string;
  let source: Source | null = null, error = '';
  const controller = new AbortController();
  onMount(() => {
    libraryRead<Source>('/asset/source', { bundle, file }, controller.signal)
      .then(value => source = value).catch(cause => { if (!controller.signal.aborted) error = cause.message; });
  });
  onDestroy(() => controller.abort());
</script>

<header><h2>{file.split('/').at(-1)}</h2>
  {#if source}<a class="btn btn-secondary" href={'#/edit?' + new URLSearchParams({ bundle, file, returnTo })}>Edit file</a>{/if}
</header>
{#if error}<p role="alert">{error}</p>
{:else if source}
  <p class="muted small">Supporting file in <a href={'#/asset?ref=' + encodeURIComponent(source.ref)}>{source.ref.split('//').at(-1)}</a></p>
  {#if source.markdown}<Markdown content={source.content} ref={source.ref} />{:else}<pre class="code">{source.content}</pre>{/if}
{:else}<p role="status">Opening skill file…</p>{/if}
<style>header{display:flex;align-items:center;justify-content:space-between;gap:24px}h2{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
