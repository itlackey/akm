<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { api, ApiError, bodyOf, pickFolder, saveContent } from "./client";
  import { libraryRead, documentTitle } from "./library-model";
  import { folderUnder } from "./library-files-model";
  import { clearDraft, draftKey, readDraft, setUnsaved, storeDraft } from "./drafts";
  import type { Bundle, FrontmatterRead, Json, Source, TextCheck, WriteResult } from "./types";
  import PropertiesForm from "./PropertiesForm.svelte";
  import Markdown from "./Markdown.svelte";
  import Diff from "./Diff.svelte";
  import Icon from "./Icon.svelte";
  import { navigate } from "./navigation";
  import { formatMarkdown, markdownCommands } from "./editor-commands.mjs";
  let {
    ref = "",
    file = undefined,
    bundles = [],
    defaultWriteTarget = "",
    query = new URLSearchParams(),
    returnTo = "/library/search",
    cancelHref = "",
    readingHref = "",
    onSaved = undefined,
  }: {
    ref?: string;
    file?: { bundle: string; path: string };
    bundles?: Bundle[];
    defaultWriteTarget?: string;
    query?: URLSearchParams;
    returnTo?: string;
    cancelHref?: string;
    readingHref?: string;
    onSaved?: (ref: string, unchanged: boolean, saved?: { bundle: string; file: string }) => void | Promise<void>;
  } = $props();
  let source = $state<Source | null>(null),
    latest = $state<Source | null>(null),
    draft = $state(""),
    error = $state(""),
    busy = $state(false),
    loaded = $state(false),
    preview = $state(false);
  let bundle = $state(""),
    name = $state(""),
    folder = $state(""),
    folderInput = $state<HTMLInputElement>();
  let writeTab = $state<HTMLButtonElement>(),
    previewTab = $state<HTMLButtonElement>();
  let controller = new AbortController();
  let alive = true;
  let recovered = $state(false),
    retained = $state(false),
    discarding = $state(false);
  let initialDraft = "",
    initialName = "",
    initialBundle = "",
    initialFolder = "";
  let editorHeading = $state<HTMLHeadingElement>(),
    errorBox = $state<HTMLDivElement>();
  let textarea = $state<HTMLTextAreaElement>();
  // akm's reading of the frontmatter (the form) and its check of the text that would be saved (the findings).
  let properties = $state<FrontmatterRead | null>(null),
    propertiesFailure = $state(""),
    textMode = $state(false),
    check = $state<TextCheck | null>(null),
    checkFailure = $state(""),
    blocked = $state<TextCheck | null>(null),
    analysisRun = 0;
  const creating = $derived(!ref && !file);
  const sourceParams = $derived<Record<string, string>>(file ? { bundle: file.bundle, file: file.path } : { ref });
  const markdown = $derived(source?.markdown !== false);
  const documentHref = $derived(
    "/library/asset?ref=" + encodeURIComponent(ref) + "&returnTo=" + encodeURIComponent(returnTo),
  );
  const backHref = $derived(
    cancelHref || (returnTo.startsWith("/library/files") ? returnTo : creating ? returnTo : documentHref),
  );
  const readerHref = $derived(readingHref || query.get("readingFrom") || "");
  const writable = $derived(bundles.filter((b) => b.writeBlocker === null));
  const bundlePath = $derived(bundles.find((b) => b.name === bundle)?.path);
  const root = $derived(bundlePath ? bundlePath.replace(/[\\/]+$/, "") + "/knowledge" : "");
  const where = $derived(source?.bundle && source.file ? { bundle: source.bundle, path: source.file } : null);
  // The form edits the frontmatter through akm and the box holds the body; Text shows the whole file in the box.
  const formMode = $derived(markdown && !!properties && !properties.error && !textMode);
  const shown = $derived(formMode ? bodyOf(draft) : draft);
  const head = (text: string) => text.slice(0, text.length - bodyOf(text).length);
  const key = () => draftKey({ file, ref });
  function persist() {
    retained = true;
    setUnsaved(true);
    storeDraft(key(), { draft, bundle, name, folder, baseRevision: source?.revision, baseContent: source?.content });
  }
  async function initialize() {
    busy = true;
    error = "";
    setUnsaved(false);
    try {
      if (ref || file) {
        source = await libraryRead<Source>("/desktop/file", sourceParams, controller.signal);
        draft = source.content.replace(/\r\n?/g, "\n");
      } else {
        bundle =
          writable.find((b) => b.name === query.get("bundle"))?.name ??
          writable.find((b) => b.name === defaultWriteTarget)?.name ??
          writable[0]?.name ??
          "";
        const wanted = query.get("q") || "New document";
        name =
          query.get("name") ??
          (query.get("q") ?? "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        draft = `# ${wanted}\n\n`;
        const location = query.get("path") ?? "";
        folder = location === "knowledge" ? "" : location.startsWith("knowledge/") ? location.slice(10) : "";
      }
      initialDraft = draft;
      initialName = name;
      initialBundle = bundle;
      initialFolder = folder;
      const stored = readDraft(key());
      if (stored) {
        if (typeof stored.draft === "string") {
          retained = true;
          draft = stored.draft;
          if (typeof stored.bundle === "string") bundle = stored.bundle || bundle;
          if (typeof stored.name === "string") name = stored.name || name;
          if (typeof stored.folder === "string") folder = stored.folder;
          if (source && typeof stored.baseRevision === "string" && stored.baseRevision !== source.revision) {
            latest = source;
            source = {
              ...source,
              revision: stored.baseRevision,
              content: typeof stored.baseContent === "string" ? stored.baseContent : source.content,
            };
            error = "The source changed while this draft was closed. Review the newer version before saving.";
          }
          setUnsaved(true);
        }
      }
      // What the box holds (the body, or the whole file) is known before the editor opens, so it never changes under the person.
      await analyze();
      loaded = true;
      recovered = retained;
      await tick();
      if (matchMedia("(max-width:850px)").matches) editorHeading?.focus();
    } catch (e) {
      if ((e as Error).name !== "AbortError") error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function save(reviewed = false, anyway = false) {
    if (busy || (!creating && !retained) || (latest && !reviewed)) return;
    busy = true;
    error = "";
    let writeCompleted = false;
    try {
      const base = reviewed ? latest : source;
      // akm checks the text that is about to be written. A text it could not read as the asset stops here; one it could
      // not check at all is saved and said so by the findings beside the editor.
      if (!creating && where && !anyway) {
        try {
          const verdict = await api<TextCheck>("/documents/check", {}, { ...where, content: toSave(base!) });
          check = verdict;
          checkFailure = "";
          if (!verdict.readable) {
            blocked = verdict;
            return;
          }
        } catch (cause) {
          checkFailure = (cause as Error).message;
        }
      }
      blocked = null;
      const result = creating
        ? await api<WriteResult>("/knowledge/create", {}, { bundle, name, path: folder, content: draft })
        : await api<WriteResult>(
            "/desktop/file/save",
            {},
            { ...sourceParams, revision: base!.revision, content: saveContent(base!.content, draft) },
          );
      // Leaving an in-flight writer must not redirect or clear a newer editor's unsaved state.
      if (!alive) return;
      writeCompleted = true;
      clearDraft(key());
      setUnsaved(false);
      retained = false;
      recovered = false;
      if (Array.isArray(result.warnings) && result.warnings.length) {
        source = await libraryRead<Source>("/desktop/file", sourceParams);
        error = "Saved. AKM reports: " + result.warnings.join(" ");
        return;
      }
      const savedRef = result.ref ?? ref;
      const savedBundle = (result.bundle as string | undefined) ?? where?.bundle,
        savedFile = (result.file as string | undefined) ?? where?.path;
      if (onSaved)
        await onSaved(
          savedRef,
          !!result.unchanged,
          savedBundle && savedFile ? { bundle: savedBundle, file: savedFile } : undefined,
        );
      else {
        const params = new URLSearchParams(returnTo.startsWith("/library/files") ? (returnTo.split("?")[1] ?? "") : "");
        params.set("ref", savedRef);
        params.set("open", "1");
        params.set("saved", result.unchanged ? "unchanged" : "1");
        if (readerHref) params.set("readingFrom", readerHref);
        await navigate(`/library/files?${params}`);
      }
    } catch (e) {
      error = writeCompleted
        ? `The write completed, but the saved document could not be opened. ${(e as Error).message}`
        : creating && e instanceof ApiError && e.code === "RESOURCE_ALREADY_EXISTS"
          ? "That file name is already used in this folder. Choose a different file name; the existing asset has not been changed."
          : (e as Error).message;
      if (e instanceof ApiError && e.code === "ASSET_CONTENT_CHANGED") {
        try {
          latest = await libraryRead<Source>("/desktop/file", sourceParams);
        } catch (e) {
          error += ` ${(e as Error).message}`;
        }
      }
    } finally {
      busy = false;
      if (error && alive) {
        await tick();
        errorBox?.focus();
      }
    }
  }
  async function discard() {
    if (latest) {
      source = latest;
      latest = null;
      error = "";
    }
    draft = source?.content ?? initialDraft;
    name = initialName;
    bundle = initialBundle;
    folder = initialFolder;
    clearDraft(key());
    setUnsaved(false);
    retained = false;
    recovered = false;
    discarding = false;
    await tick();
    editorHeading?.focus();
  }
  async function keepEditing() {
    discarding = false;
    await tick();
    (preview ? previewTab : writeTab)?.focus();
  }
  async function tabKey(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    preview = event.key === "ArrowRight" || event.key === "End";
    await tick();
    (preview ? previewTab : writeTab)?.focus();
  }
  async function browse() {
    error = "";
    try {
      const chosen = await pickFolder(root);
      if (chosen !== null) {
        const inside = folderUnder(root, chosen);
        if (inside === null) error = `Choose a folder inside ${root}.`;
        else {
          folder = inside;
          persist();
        }
      }
    } catch (e) {
      error = (e as Error).message;
    }
    await tick();
    folderInput?.focus();
  }
  async function format(command: string) {
    const area = textarea;
    if (busy || preview || !area) return;
    const scrollTop = area.scrollTop;
    const formatted = formatMarkdown(shown, area.selectionStart, area.selectionEnd, command);
    // Chromium's plain-text edit command retains native Undo/Redo. Assigning
    // textarea.value (or setRangeText) does not. Never insert HTML here.
    let first = 0,
      oldEnd = shown.length,
      newEnd = formatted.content.length;
    while (first < oldEnd && first < newEnd && shown[first] === formatted.content[first]) first++;
    while (oldEnd > first && newEnd > first && shown[oldEnd - 1] === formatted.content[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    area.focus({ preventScroll: true });
    area.setSelectionRange(first, oldEnd);
    const replacement = formatted.content.slice(first, newEnd);
    if (typeof document.execCommand !== "function" || !document.execCommand("insertText", false, replacement))
      area.setRangeText(replacement, first, oldEnd);
    setShown(area.value);
    persist();
    await tick();
    area.focus({ preventScroll: true });
    area.setSelectionRange(formatted.start, formatted.end);
    area.scrollTop = scrollTop;
  }
  function setShown(value: string) {
    draft = formMode ? head(draft) + value : value;
  }
  /** The text that would be written: what the check and the save are both given. */
  const toSave = (base: Source) => saveContent(base.content, draft);
  async function analyze() {
    if (!where) return;
    const run = ++analysisRun;
    const [front, checked] = await Promise.allSettled([
      markdown
        ? api<FrontmatterRead>("/documents/frontmatter", {}, { ...where, content: draft })
        : Promise.resolve(null),
      api<TextCheck>("/documents/check", {}, { ...where, content: toSave(source!) }),
    ]);
    if (run !== analysisRun || !alive) return;
    properties = front.status === "fulfilled" ? front.value : null;
    propertiesFailure = front.status === "rejected" ? front.reason.message : "";
    check = checked.status === "fulfilled" ? checked.value : null;
    checkFailure = checked.status === "rejected" ? checked.reason.message : "";
  }
  async function applyChange(change: { key: string; value?: Json; remove?: true }) {
    try {
      const result = await api<{ content: string }>(
        "/documents/apply-frontmatter",
        {},
        { content: draft, changes: [change] },
      );
      draft = result.content;
      error = "";
      persist();
      await analyze();
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
  /** Put the cursor on a line of the file: the whole file is in the box in Text. */
  async function jumpTo(line: number) {
    textMode = true;
    preview = false;
    await tick();
    const area = textarea;
    if (!area) return;
    const offset =
      draft
        .split("\n")
        .slice(0, line - 1)
        .join("\n").length + (line > 1 ? 1 : 0);
    area.focus();
    area.setSelectionRange(offset, offset);
  }
  function editorKey(event: KeyboardEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      textarea?.form?.requestSubmit();
    } else if (markdown && !event.shiftKey && !event.altKey && ["b", "i", "k"].includes(key)) {
      event.preventDefault();
      format(key === "b" ? "bold" : key === "i" ? "italic" : "link");
    }
  }
  // The form and the findings follow the text a moment after it stops changing.
  $effect(() => {
    void draft;
    if (!loaded || creating) return;
    const timer = setTimeout(() => void analyze(), 400);
    return () => clearTimeout(timer);
  });
  onMount(initialize);
  onDestroy(() => {
    alive = false;
    controller.abort();
  });
</script>

<div class="editor-header">
  <h1 bind:this={editorHeading} tabindex="-1">
    {creating
      ? "New knowledge"
      : file
        ? file.path.split("/").at(-1)
        : source
          ? documentTitle({ ref, content: source.content })
          : "Opening editor…"}
  </h1>
  <div class="editor-return">
    <a href={backHref}
      ><Icon name="arrow-left" size={16} />{creating
        ? "Cancel"
        : backHref.startsWith("/library/files")
          ? "Back to file"
          : "Back to document"}</a
    >
  </div>
</div>
{#if error}<div class="notice notice-warn" role="alert" tabindex="-1" bind:this={errorBox}>
    {error}{loaded && retained ? " Your draft is retained." : ""}{#if !loaded && (ref || file)}<p>
        <a href={ref ? documentHref : backHref}>Open read-only</a> · Refresh the index if the source no longer matches.
      </p>{/if}
  </div>{/if}
{#if creating && !writable.length}<p class="state">
    No bundle accepts writes.{#each bundles as b}<br />{b.name}: {b.writeBlocker}{/each}
  </p>
{:else if loaded}<form
    class="editor-form"
    class:grows={formMode}
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <fieldset class="editor-fields" disabled={busy}>
      {#if creating}<div class="settings-grid">
          <label
            >Bundle<select bind:value={bundle} onchange={persist}
              >{#each bundles as b}<option value={b.name} disabled={b.writeBlocker !== null}
                  >{b.name}{b.writeBlocker === null ? "" : ": " + b.writeBlocker}</option
                >{/each}</select
            ></label
          ><label>File name<input bind:value={name} required oninput={persist} placeholder="recovery-guide" /></label
          ><label
            >Folder under knowledge/
            <div class="field-control">
              <input bind:this={folderInput} bind:value={folder} oninput={persist} placeholder="Optional" /><button
                type="button"
                class="btn-secondary"
                onclick={browse}>Browse…</button
              >
            </div></label
          >
        </div>{/if}
      <div class="editor-toolbar">
        <div class="editor-tabs" role="tablist" tabindex="-1" aria-label="Editor view" onkeydown={tabKey}>
          <button
            type="button"
            role="tab"
            id="editor-write-tab"
            aria-controls="editor-write"
            aria-selected={!preview}
            tabindex={preview ? -1 : 0}
            bind:this={writeTab}
            onclick={() => (preview = false)}>{markdown ? "Markdown" : "Source"}</button
          ><button
            type="button"
            role="tab"
            id="editor-preview-tab"
            aria-controls="editor-preview"
            aria-selected={preview}
            tabindex={preview ? 0 : -1}
            bind:this={previewTab}
            onclick={() => (preview = true)}>Preview</button
          >
        </div>
        <button class="save-action" disabled={busy || !!latest || (!creating && !retained)}
          >{busy ? "Saving…" : creating ? "Create knowledge" : "Save changes"}</button
        >
      </div>
      <div class="editor-status">
        <div>
          <span role="status"
            >{retained
              ? recovered
                ? "Restored unsaved draft · kept in this window"
                : "Unsaved changes · kept in this window"
              : "No unsaved changes"}</span
          ><span class="save-policy"
            >{creating ? bundle : (file?.bundle ?? ref.split("//")[0])} · {creating
              ? "AKM policy may commit and push."
              : "Saved to the file; Git is not changed."}</span
          >
        </div>
        {#if retained}<button type="button" class="discard-action quiet" onclick={() => (discarding = true)}
            >Discard draft…</button
          >{/if}
      </div>
      {#if discarding}<div class="notice" role="alert">
          <p>Discard this unsaved draft? Your saved asset will not change.</p>
          <div class="btn-row">
            <button type="button" class="btn-secondary" onclick={keepEditing}>Keep editing</button><button
              type="button"
              class="btn-danger"
              onclick={discard}>Discard draft</button
            >
          </div>
        </div>{/if}
      {#if blocked}<div class="notice notice-warn" role="alert">
          <p class="reason">
            <strong>Not saved.</strong> akm could not read this as an asset: {blocked.unreadable?.reason}{blocked
              .unreadable?.line
              ? ` (line ${blocked.unreadable.line})`
              : ""}
          </p>
          <div class="btn-row">
            <button type="button" class="btn-secondary" onclick={() => (blocked = null)}>Keep editing</button><button
              type="button"
              class="btn-danger"
              onclick={() => save(!!latest, true)}>Save anyway</button
            >
          </div>
        </div>{/if}
      {#if !creating && markdown}<div class="properties-switch" role="group" aria-label="Frontmatter view">
          <button
            type="button"
            class="quiet"
            aria-pressed={!textMode}
            aria-disabled={!properties || properties.error ? "true" : undefined}
            onclick={() => properties && !properties.error && (textMode = false)}>Fields</button
          ><button type="button" class="quiet" aria-pressed={textMode} onclick={() => (textMode = true)}>Text</button>
          {#if propertiesFailure}<span class="muted small">Fields are not available: {propertiesFailure}</span
            >{:else if properties?.error}<span class="muted small" role="status"
              >The frontmatter cannot be read as fields: {properties.error.reason}{properties.error.line
                ? ` (line ${properties.error.line})`
                : ""}. Edit it as text.</span
            >{/if}
        </div>
        {#if formMode && properties}<PropertiesForm {properties} disabled={busy} onChange={applyChange} />{/if}{/if}
      <div class="editor-columns">
        <div hidden={preview} role="tabpanel" id="editor-write" aria-labelledby="editor-write-tab">
          {#if markdown}<div class="formatting-tools" role="group" aria-label="Markdown formatting">
              {#each markdownCommands as command}<button
                  type="button"
                  class:bold-tool={command.id === "bold"}
                  class:italic-tool={command.id === "italic"}
                  aria-label={command.label}
                  title={command.label + (command.shortcut ? ` (${command.shortcut})` : "")}
                  onmousedown={(event) => event.preventDefault()}
                  onclick={() => format(command.id)}
                  >{command.id === "link"
                    ? "Link"
                    : command.id === "bullet"
                      ? "Bullets"
                      : command.id === "number"
                        ? "Numbers"
                        : command.label}</button
                >{/each}
            </div>{/if}
          <label
            ><span class="sr-only"
              >{markdown
                ? formMode
                  ? "Markdown body"
                  : "Markdown source, including optional frontmatter"
                : "Text source"}</span
            ><textarea
              bind:this={textarea}
              class="source-editor"
              name="content"
              value={shown}
              rows="24"
              spellcheck={markdown}
              oninput={(event) => {
                setShown(event.currentTarget.value);
                persist();
              }}
              onkeydown={editorKey}></textarea></label
          >
        </div>
        <div hidden={!preview} role="tabpanel" id="editor-preview" aria-labelledby="editor-preview-tab">
          {#if markdown}<Markdown content={draft} {ref} />{:else}<pre class="code">{draft}</pre>{/if}
        </div>
        {#if !creating}<aside class="findings" aria-label="Checks">
            {#if checkFailure}<p class="muted small">akm could not check this text: {checkFailure}</p>
            {:else if check}
              {#if check.unreadable}<p class="notice notice-warn reason">
                  akm could not read this as an asset: {check.unreadable.reason}
                  {#if check.unreadable.line}<button
                      type="button"
                      class="text-action"
                      onclick={() => jumpTo(check!.unreadable!.line!)}>Line {check.unreadable.line}</button
                    >{/if}
                </p>{/if}
              {#if check.findings.length || check.warnings.length}<ul class="plain">
                  {#each [...check.findings, ...check.warnings] as finding}<li>
                      {#if finding.line}<button type="button" class="text-action" onclick={() => jumpTo(finding.line!)}
                          >Line {finding.line}</button
                        >{/if}
                      <strong>{finding.issue}</strong>: {finding.detail}
                    </li>{/each}
                </ul>{:else}<p class="muted small">akm found no problems.</p>{/if}
            {/if}
          </aside>{/if}
      </div>
    </fieldset>
  </form>{/if}
{#if latest}<section class="notice notice-warn conflict">
    <h3>A newer version exists</h3>
    <p>
      Your draft is retained. Compare the live source, incorporate anything needed, then save your reviewed version
      against the new revision.
    </p>
    <Diff before={latest.content} after={draft} afterLabel="Your retained draft" /><button
      disabled={busy}
      onclick={() => save(true)}>Save reviewed version</button
    >
  </section>{/if}

<style>
  .editor-header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 24px;
    margin-bottom: 16px;
  }
  .editor-header h1 {
    font-size: 26px;
    line-height: 1.25;
    letter-spacing: -0.02em;
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .editor-header h1[tabindex="-1"]:focus {
    outline: none;
  }
  /* The title wraps; the return link keeps its line and its place beside it. */
  .editor-return {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    justify-content: end;
    gap: 8px 20px;
    font-size: 13px;
  }
  .editor-return a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0;
    white-space: nowrap;
  }
  .reason {
    white-space: pre-line;
  }
  .editor-columns {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .findings {
    font-size: 13px;
  }
  .findings ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 6px;
  }
  .properties-switch {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin: 12px 0 8px;
  }
  .properties-switch button[aria-pressed="true"] {
    background: var(--accent-bg);
    color: var(--accent);
  }
  @media (min-width: 1100px) {
    .editor-columns {
      grid-template-columns: minmax(0, 1fr) 280px;
    }
  }
  .editor-form {
    margin: 0;
  }
  .editor-fields {
    border: 0;
    margin: 0;
    padding: 0;
    min-inline-size: 0;
  }
  .settings-grid {
    margin-bottom: 24px;
  }
  .settings-grid > label {
    display: grid;
    gap: 8px;
    align-content: start;
  }
  .editor-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px 16px;
  }
  .editor-tabs {
    display: flex;
    gap: 4px;
    background: var(--surface-2);
    border-radius: 5px;
    padding: 3px;
  }
  .editor-tabs {
    justify-self: start;
  }
  .editor-tabs button {
    background: none;
    border: 1px solid transparent;
    color: var(--muted);
    font-size: 13px;
    min-height: var(--control-height, 40px);
    padding: 6px 12px;
  }
  .editor-tabs button[aria-selected="true"] {
    border-color: var(--border);
    background: var(--surface);
    color: var(--text);
  }
  .save-action {
    grid-column: 2;
    grid-row: 1;
    white-space: nowrap;
    font-size: 13px;
    min-height: var(--control-height, 40px);
    padding: 8px 16px;
  }
  .editor-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .editor-status > div {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 20px;
  }
  .discard-action {
    background: none;
    border: 0;
    color: var(--muted);
    font-size: 12px;
    padding: 8px 0;
    font-weight: 400;
    white-space: nowrap;
  }
  .discard-action:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .save-policy {
    color: var(--muted);
  }
  .editor-fields [role="tabpanel"] > label {
    display: block;
  }
  .formatting-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 4px;
    background: var(--surface-2);
    border-radius: var(--radius, 6px);
    max-width: fit-content;
    margin-bottom: 12px;
  }
  .formatting-tools button {
    background: none;
    color: var(--muted);
    border: 1px solid transparent;
    min-height: var(--control-height, 40px);
    padding: 6px 10px;
    font-size: 13px;
    font-weight: 500;
  }
  .formatting-tools button:hover {
    background: var(--surface);
    color: var(--text);
  }
  .formatting-tools .bold-tool {
    font-weight: 750;
  }
  .formatting-tools .italic-tool {
    font-style: italic;
  }
  .source-editor {
    display: block;
    inline-size: 100%;
    font-family: var(--mono);
    font-size: 14px;
    line-height: 1.75;
    min-height: 440px;
    height: calc(100dvh - 390px);
    padding: 8px 0;
    border: 0;
    border-radius: 0;
    resize: vertical;
    background: var(--surface);
    box-shadow: none;
  }
  .source-editor:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 6px;
  }
  #editor-preview {
    max-width: 76ch;
    padding-top: 16px;
    font-size: 16px;
    line-height: 1.75;
  }
  #editor-preview :global(.md) {
    padding: 0;
    border: 0;
    background: none;
  }
  #editor-preview :global(blockquote) {
    border-inline-start: 2px solid var(--border-strong);
    padding: 8px 20px;
    margin: 24px 0;
    color: var(--muted);
  }
  /* Beside the folder tree the editor fills the pane: the text area takes the height the header leaves and scrolls its
     own text, so the pane itself does not scroll. */
  @media (min-width: 851px) {
    .editor-form,
    .editor-fields,
    #editor-write:not([hidden]) {
      display: flex;
      flex: 1;
      flex-direction: column;
      min-block-size: 0;
    }
    .editor-columns {
      flex: 1;
      min-block-size: 0;
      grid-template-rows: minmax(0, 1fr);
    }
    .editor-form.grows .editor-columns {
      flex: none;
      grid-template-rows: auto;
    }
    .findings {
      overflow: auto;
    }
    #editor-write:not([hidden]) > label {
      display: flex;
      flex: 1;
      min-block-size: 0;
    }
    .source-editor {
      flex: 1;
      height: auto;
      min-block-size: 240px;
      resize: none;
    }
    #editor-preview:not([hidden]) {
      flex: 1;
      min-block-size: 0;
      overflow: auto;
    }
  }
  /* With the properties above it the body takes the height its text needs and the pane scrolls: one place, not two. */
  @media (min-width: 851px) {
    .editor-form.grows .source-editor {
      flex: 1 1 auto;
      inline-size: 100%;
      field-sizing: content;
      min-block-size: 320px;
    }
  }
  @media (max-width: 850px) {
    .editor-header {
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }
    .editor-header h1 {
      font-size: 24px;
    }
    .editor-toolbar {
      gap: 8px;
    }
    .editor-tabs button {
      padding-inline: 8px;
      font-size: 12px;
    }
    .save-action {
      padding-inline: 10px;
    }
    .source-editor {
      height: auto;
      min-height: 420px;
    }
    .editor-status {
      flex-wrap: wrap;
      gap: 4px;
      padding: 10px 0;
    }
    .editor-status > div {
      gap: 4px 12px;
    }
    .editor-return {
      justify-content: start;
    }
    .formatting-tools button {
      padding-inline: 8px;
    }
  }
  @media (max-width: 380px) {
    .editor-toolbar {
      grid-template-columns: 1fr;
    }
    .save-action {
      grid-row: 2;
      grid-column: 1;
      justify-self: start;
    }
    .editor-return {
      gap: 4px 12px;
    }
  }
  @media (max-width: 650px) {
    .formatting-tools {
      flex-wrap: nowrap;
      max-width: 100%;
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border-strong) transparent;
      padding-bottom: 6px;
    }
    .formatting-tools button {
      flex: none;
    }
  }
</style>
