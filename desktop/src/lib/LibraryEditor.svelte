<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { api, ApiError, saveContent } from './client';
  import { libraryRead, documentTitle } from './library-model';
  import { setUnsaved } from './upstream/lib.js';
  import type { Bundle, Source, WriteResult } from './types';
  import Markdown from './Markdown.svelte';
  import Diff from './Diff.svelte';
  import FolderPicker from './LibraryFolderPicker.svelte';
  import Icon from './Icon.svelte';
  import { navigate } from './navigation';
  import { formatMarkdown, markdownCommands } from './editor-commands.mjs';
  export let ref = '';
  export let file: { bundle: string; path: string } | undefined = undefined;
  export let bundles: Bundle[] = [];
  export let defaultWriteTarget = '';
  export let query = new URLSearchParams();
  export let returnTo = '#/search';
  export let cancelHref = '';
  export let readingHref = '';
  export let onSaved: ((ref: string, unchanged: boolean) => void | Promise<void>) | undefined = undefined;
  let source: Source | null = null, latest: Source | null = null, draft = '', error = '', busy = false, loaded = false, preview = false;
  let bundle = '', name = '', folder = '', picker = false, folderInput: HTMLInputElement;
  let writeTab: HTMLButtonElement, previewTab: HTMLButtonElement;
  let controller = new AbortController();
  let alive = true;
  let recovered = false, retained = false, discarding = false;
  let initialDraft = '', initialName = '', initialBundle = '', initialFolder = '';
  let editorHeading: HTMLHeadingElement, errorBox: HTMLDivElement;
  let textarea: HTMLTextAreaElement;
  let sourceParams: Record<string, string>;
  $: creating = !ref && !file;
  $: if (file) sourceParams = { bundle: file.bundle, file: file.path }; else sourceParams = { ref };
  $: markdown = source?.markdown !== false;
  $: documentHref = '#/asset?ref=' + encodeURIComponent(ref) + '&returnTo=' + encodeURIComponent(returnTo);
  $: backHref = cancelHref || (returnTo.startsWith('#/files') ? returnTo : creating ? returnTo : documentHref);
  $: readerHref = readingHref || query.get('readingFrom') || '';
  $: writable = bundles.filter((b) => b.enabled && b.writable && b.components.some((c) => c.adapter === 'akm'));
  $: bundlePath = bundles.find((b) => b.name === bundle)?.path;
  $: root = bundlePath ? bundlePath.replace(/[\\/]+$/, '') + '/knowledge' : '';
  const key = () => `akm-desktop-editor:${file ? file.bundle + '/' + file.path : ref || 'new'}`;
  function persist() {
    retained = true;
    setUnsaved(true);
    try { sessionStorage.setItem(key(), JSON.stringify({ draft, bundle, name, folder, baseRevision: source?.revision, baseContent: source?.content })); } catch { /* draft remains in memory */ }
  }
  async function initialize() {
    busy = true; error = ''; setUnsaved(false);
    try {
      if (ref || file) { source = await libraryRead<Source>('/desktop/file', sourceParams, controller.signal); draft = source.content.replace(/\r\n?/g, '\n'); }
      else {
        bundle = writable.find((b) => b.name === query.get('bundle'))?.name ?? writable.find((b) => b.name === defaultWriteTarget)?.name ?? writable[0]?.name ?? '';
        const wanted = query.get('q') || 'New document'; name = query.get('name') ?? (query.get('q') ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); draft = `# ${wanted}\n\n`;
        const location = query.get('path') ?? ''; folder = location === 'knowledge' ? '' : location.startsWith('knowledge/') ? location.slice(10) : '';
      }
      initialDraft = draft; initialName = name; initialBundle = bundle; initialFolder = folder;
      const saved = sessionStorage.getItem(key());
      if (saved) {
        const recovered = JSON.parse(saved);
        if (typeof recovered.draft === 'string') {
          retained = true;
          draft = recovered.draft;
          if (typeof recovered.bundle === 'string') bundle = recovered.bundle || bundle;
          if (typeof recovered.name === 'string') name = recovered.name || name;
          if (typeof recovered.folder === 'string') folder = recovered.folder;
          if (source && typeof recovered.baseRevision === 'string' && recovered.baseRevision !== source.revision) {
            latest = source;
            source = { ...source, revision: recovered.baseRevision, content: typeof recovered.baseContent === 'string' ? recovered.baseContent : source.content };
            error = 'The source changed while this draft was closed. Review the newer version before saving.';
          }
          setUnsaved(true);
        }
      }
      loaded = true;
      recovered = retained;
      await tick();
      if (matchMedia('(max-width:850px)').matches) editorHeading?.focus();
    } catch (e) { if ((e as Error).name !== 'AbortError') error = (e as Error).message; }
    finally { busy = false; }
  }
  async function save(reviewed = false) {
    if (busy || (!creating && !retained) || (latest && !reviewed)) return;
    busy = true; error = '';
    let writeCompleted = false;
    try {
      const base = reviewed ? latest : source;
      const result = creating ? await api<WriteResult>('/knowledge/create', {}, { bundle, name, path: folder, content: draft }) : await api<WriteResult>('/desktop/file/save', {}, { ...sourceParams, revision: base!.revision, content: saveContent(base!.content, draft) });
      // Leaving an in-flight writer must not redirect or clear a newer editor's unsaved state.
      if (!alive) return;
      writeCompleted = true;
      try { sessionStorage.removeItem(key()); } catch { /* the successful core write is authoritative */ }
      setUnsaved(false); retained = false; recovered = false;
      if (Array.isArray(result.warnings) && result.warnings.length) {
        source = await libraryRead<Source>('/desktop/file', sourceParams);
        error = 'Saved. AKM reports: ' + result.warnings.join(' ');
        return;
      }
      const savedRef = result.ref ?? ref;
      if (onSaved) await onSaved(savedRef, !!result.unchanged);
      else {
        const params = new URLSearchParams(returnTo.startsWith('#/files') ? returnTo.split('?')[1] ?? '' : '');
        params.set('ref', savedRef); params.set('open', '1'); params.set('saved', result.unchanged ? 'unchanged' : '1');
        if (readerHref) params.set('readingFrom', readerHref);
        await navigate(`#/files?${params}`);
      }
    } catch (e) {
      error = writeCompleted ? `The write completed, but the saved document could not be opened. ${(e as Error).message}` : creating && /already exists/i.test((e as Error).message) ? 'That file name is already used in this folder. Choose a different file name; the existing asset has not been changed.' : (e as Error).message;
      if (e instanceof ApiError && e.code === 'ASSET_CONTENT_CHANGED') { try { latest = await libraryRead<Source>('/desktop/file', sourceParams); } catch (e) { error += ` ${(e as Error).message}`; } }
    } finally { busy = false; if (error && alive) { await tick(); errorBox?.focus(); } }
  }
  async function discard() {
    if (latest) { source = latest; latest = null; error = ''; }
    draft = source?.content ?? initialDraft; name = initialName; bundle = initialBundle; folder = initialFolder;
    sessionStorage.removeItem(key()); setUnsaved(false); retained = false; recovered = false; discarding = false;
    await tick(); editorHeading?.focus();
  }
  async function keepEditing() { discarding = false; await tick(); (preview ? previewTab : writeTab)?.focus(); }
  async function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); preview = event.key === 'ArrowRight' || event.key === 'End'; await tick(); (preview ? previewTab : writeTab).focus();
  }
  function closePicker() { picker = false; tick().then(() => folderInput?.focus()); }
  async function format(command: string) {
    if (busy || preview || !textarea) return;
    const scrollTop = textarea.scrollTop;
    const formatted = formatMarkdown(draft, textarea.selectionStart, textarea.selectionEnd, command);
    // Chromium's plain-text edit command retains native Undo/Redo. Assigning
    // textarea.value (or setRangeText) does not. Never insert HTML here.
    let first = 0, oldEnd = draft.length, newEnd = formatted.content.length;
    while (first < oldEnd && first < newEnd && draft[first] === formatted.content[first]) first++;
    while (oldEnd > first && newEnd > first && draft[oldEnd - 1] === formatted.content[newEnd - 1]) { oldEnd--; newEnd--; }
    textarea.focus({ preventScroll: true }); textarea.setSelectionRange(first, oldEnd);
    const replacement = formatted.content.slice(first, newEnd);
    if (typeof document.execCommand !== 'function' || !document.execCommand('insertText', false, replacement)) textarea.setRangeText(replacement, first, oldEnd);
    draft = textarea.value; persist();
    await tick(); textarea.focus({ preventScroll: true }); textarea.setSelectionRange(formatted.start, formatted.end); textarea.scrollTop = scrollTop;
  }
  function editorKey(event: KeyboardEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); textarea.form?.requestSubmit(); }
    else if (markdown && !event.shiftKey && !event.altKey && ['b', 'i', 'k'].includes(key)) { event.preventDefault(); format(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'link'); }
  }
  onMount(initialize);
  onDestroy(() => { alive = false; controller.abort(); });
</script>

<div class="editor-header">
  <h2 bind:this={editorHeading} tabindex="-1">{creating ? 'New knowledge' : file ? file.path.split('/').at(-1) : source ? documentTitle({ ref, content: source.content }) : 'Opening editor…'}</h2>
  <div class="editor-return"><a href={backHref}><Icon name="arrow-left" size={16} />{creating ? 'Cancel' : backHref.startsWith('#/files') ? 'Back to file' : 'Back to document'}</a></div>
</div>
{#if error}<div class="notice notice-warn" role="alert" tabindex="-1" bind:this={errorBox}>{error}{loaded && retained ? ' Your draft is retained.' : ''}{#if !loaded && (ref || file)}<p><a href={ref ? documentHref : backHref}>Open read-only</a> · Refresh the index if the source no longer matches.</p>{/if}</div>{/if}
{#if creating && !writable.length}<p class="state">No enabled writable AKM bundle is available. Check bundle settings.</p>
{:else if loaded}<form class="editor-form" on:submit|preventDefault={() => save()}><fieldset class="editor-fields" disabled={busy}>
  {#if creating}<div class="settings-grid"><label>Bundle<select bind:value={bundle} on:change={persist}>{#each writable as b}<option value={b.name}>{b.name}</option>{/each}</select></label><label>File name<input bind:value={name} required on:input={persist} placeholder="recovery-guide" /></label><label>Folder under knowledge/<div class="field-control"><input bind:this={folderInput} bind:value={folder} on:input={persist} placeholder="Optional" /><button type="button" class="btn-secondary" on:click={() => picker = true}>Browse…</button></div></label></div>{/if}
  <div class="editor-toolbar">
    <div class="editor-tabs" role="tablist" tabindex="-1" aria-label="Editor view" on:keydown={tabKey}><button type="button" role="tab" id="editor-write-tab" aria-controls="editor-write" aria-selected={!preview} tabindex={preview ? -1 : 0} bind:this={writeTab} on:click={() => preview = false}>{markdown ? 'Markdown' : 'Source'}</button><button type="button" role="tab" id="editor-preview-tab" aria-controls="editor-preview" aria-selected={preview} tabindex={preview ? 0 : -1} bind:this={previewTab} on:click={() => preview = true}>Preview</button></div>
    <button class="save-action" disabled={busy || !!latest || (!creating && !retained)}>{busy ? 'Saving…' : creating ? 'Create knowledge' : 'Save changes'}</button>
  </div>
  <div class="editor-status"><div><span role="status">{retained ? recovered ? 'Restored unsaved draft · kept in this window' : 'Unsaved changes · kept in this window' : 'No unsaved changes'}</span><span class="save-policy">{creating ? bundle : file?.bundle ?? ref.split('//')[0]} · {creating ? 'AKM policy may commit and push.' : 'Saved to the file; Git is not changed.'}</span></div>{#if retained}<button type="button" class="discard-action quiet" on:click={() => discarding = true}>Discard draft…</button>{/if}</div>
  {#if discarding}<div class="notice" role="alert"><p>Discard this unsaved draft? Your saved asset will not change.</p><div class="btn-row"><button type="button" class="btn-secondary" on:click={keepEditing}>Keep editing</button><button type="button" class="btn-danger" on:click={discard}>Discard draft</button></div></div>{/if}
  <div hidden={preview} role="tabpanel" id="editor-write" aria-labelledby="editor-write-tab">
    {#if markdown}<div class="formatting-tools" role="group" aria-label="Markdown formatting">{#each markdownCommands as command}<button type="button" class:bold-tool={command.id === 'bold'} class:italic-tool={command.id === 'italic'} aria-label={command.label} title={command.label + (command.shortcut ? ` (${command.shortcut})` : '')} on:mousedown|preventDefault on:click={() => format(command.id)}>{command.id === 'link' ? 'Link' : command.id === 'bullet' ? 'Bullets' : command.id === 'number' ? 'Numbers' : command.label}</button>{/each}</div>{/if}
    <label><span class="sr-only">{markdown ? 'Markdown source, including optional frontmatter' : 'Text source'}</span><textarea bind:this={textarea} class="source-editor" name="content" bind:value={draft} rows="24" spellcheck={markdown} on:input={persist} on:keydown={editorKey}></textarea></label>
  </div>
  <div hidden={!preview} role="tabpanel" id="editor-preview" aria-labelledby="editor-preview-tab">{#if markdown}<Markdown content={draft} {ref} />{:else}<pre class="code">{draft}</pre>{/if}</div>
</fieldset></form>{/if}
{#if latest}<section class="notice notice-warn conflict"><h3>A newer version exists</h3><p>Your draft is retained. Compare the live source, incorporate anything needed, then save your reviewed version against the new revision.</p><Diff before={latest.content} after={draft} afterLabel="Your retained draft" /><button disabled={busy} on:click={() => save(true)}>Save reviewed version</button></section>{/if}
{#if picker}<FolderPicker {root} on:choose={(e) => { folder = e.detail; persist(); closePicker(); }} on:close={closePicker} />{/if}
<style>
  .editor-header{display:flex;justify-content:space-between;align-items:start;gap:24px;margin-bottom:16px}
  .editor-header h2{font-size:26px;line-height:1.25;letter-spacing:-.02em;margin:0}
  .editor-header h2[tabindex="-1"]:focus{outline:none}
  .editor-return{display:flex;flex-wrap:wrap;justify-content:end;gap:8px 20px;font-size:13px}.editor-return a{display:inline-flex;align-items:center;gap:6px;padding:8px 0}
  .editor-form{margin:0}.editor-fields{border:0;margin:0;padding:0;min-inline-size:0}
  .settings-grid{margin-bottom:24px}
  .settings-grid>label{display:grid;gap:8px;align-content:start}
  .editor-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px 16px}
  .editor-tabs{display:flex;gap:4px;background:var(--surface-2);border-radius:5px;padding:3px}
  .editor-tabs{justify-self:start}
  .editor-tabs button{background:none;border:1px solid transparent;color:var(--muted);font-size:13px;min-height:var(--control-height,40px);padding:6px 12px}
  .editor-tabs button[aria-selected=true]{border-color:var(--border);background:var(--surface);color:var(--text)}
  .save-action{grid-column:2;grid-row:1;white-space:nowrap;font-size:13px;min-height:var(--control-height,40px);padding:8px 16px}
  .editor-status{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;color:var(--muted);font-size:12px;line-height:1.5}
  .editor-status>div{display:flex;flex-wrap:wrap;gap:4px 20px}
  .discard-action{background:none;border:0;color:var(--muted);font-size:12px;padding:8px 0;font-weight:400;white-space:nowrap}
  .discard-action:hover{color:var(--text);text-decoration:underline}
  .save-policy{color:var(--muted)}
  .editor-fields [role=tabpanel]>label{display:block}
  .formatting-tools{display:flex;flex-wrap:wrap;gap:2px;padding:4px;background:var(--surface-2);border-radius:var(--radius,6px);max-width:fit-content;margin-bottom:12px}
  .formatting-tools button{background:none;color:var(--muted);border:1px solid transparent;min-height:var(--control-height,40px);padding:6px 10px;font-size:13px;font-weight:500}
  .formatting-tools button:hover{background:var(--surface);color:var(--text)}
  .formatting-tools .bold-tool{font-weight:750}.formatting-tools .italic-tool{font-style:italic}
  .source-editor{display:block;inline-size:100%;max-inline-size:90ch;font-family:var(--mono);font-size:14px;line-height:1.75;min-height:440px;height:calc(100dvh - 390px);padding:8px 0;border:0;border-radius:0;resize:vertical;background:var(--surface);box-shadow:none}
  .source-editor:focus-visible{outline:2px solid var(--accent);outline-offset:6px}
  #editor-preview{max-width:76ch;padding-top:16px;font-size:16px;line-height:1.75}
  #editor-preview :global(.md){padding:0;border:0;background:none}
  #editor-preview :global(blockquote){border-inline-start:2px solid var(--border-strong);padding:8px 20px;margin:24px 0;color:var(--muted)}
  @media(max-width:850px){.editor-header{flex-direction:column;gap:4px;margin-bottom:12px}.editor-header h2{font-size:24px}.editor-toolbar{gap:8px}.editor-tabs button{padding-inline:8px;font-size:12px}.save-action{padding-inline:10px}.source-editor{height:auto;min-height:420px}.editor-status{flex-wrap:wrap;gap:4px;padding:10px 0}.editor-status>div{gap:4px 12px}.editor-return{justify-content:start}.formatting-tools button{padding-inline:8px}}
  @media(max-width:380px){.editor-toolbar{grid-template-columns:1fr}.save-action{grid-row:2;grid-column:1;justify-self:start}.editor-return{gap:4px 12px}}
  @media(max-width:650px){.formatting-tools{flex-wrap:nowrap;max-width:100%;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--border-strong) transparent;padding-bottom:6px}.formatting-tools button{flex:none}}
</style>
