<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import { libraryRead } from "./library-model";
  import { ancestorPaths, directoryKey, parentPath, treeNodes } from "./library-files-model";
  import type { FileEntry, FileListing, FileLocation, FilesViewState, TreeNode } from "./library-files-model";
  import type { Bundle } from "./types";
  import Icon from "./Icon.svelte";
  export let bundles: Bundle[] = [];
  export let bundleName = "";
  export let path = "";
  export let file = "";
  export let documentOpen = false;
  export let revision = 0;
  export let comparisonMode = false;
  export let selectedCompare: string[] = [];
  export let viewState: FilesViewState = {};
  const dispatch = createEventDispatcher<{
    navigate: FileLocation;
    select: string;
    search: string;
    create: FileLocation;
  }>();
  let listings =
      viewState.revision === revision
        ? (viewState.listings ?? new Map<string, FileListing>())
        : new Map<string, FileListing>(),
    expanded = viewState.expanded ?? new Set<string>(),
    loading = new Set<string>(),
    errors = new Map<string, string>();
  let requests = new Map<string, Promise<void>>(),
    controller = new AbortController(),
    mounted = false,
    seen = "",
    seenRevision = revision;
  let focused = viewState.focused ?? "",
    tree: HTMLElement,
    treePane: HTMLElement,
    contentPane: HTMLElement,
    filter = "",
    showTree = false,
    showHidden = viewState.showHidden ?? false,
    notice = "",
    generation = 0;
  let restoreLocation = viewState.location;
  $: names = bundles.filter((b) => b.enabled).map((b) => b.name);
  $: nodes = treeNodes(names, listings, expanded);
  $: focusKey = nodes.some((node) => node.key === focused) ? focused : nodes[0]?.key;
  $: key = directoryKey(bundleName, path);
  $: listing = listings.get(key);
  $: selectedKey = directoryKey(bundleName, file || path);
  $: selectedFile = listing?.entries.find((entry) => entry.path === file);
  $: locationError = !names.length
    ? "No enabled bundles are available in Files."
    : bundleName && !names.includes(bundleName)
      ? "This bundle is disabled or no longer configured."
      : "";
  $: visibleEntries = (listing?.entries ?? []).filter(
    (entry) => !filter || entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  $: showStatus =
    listing?.entries.some(
      (entry) =>
        entry.unavailable || (entry.kind !== "directory" && (!listing.indexAvailable || entry.assets.length !== 1)),
    ) ?? false;
  $: if (mounted && seenRevision !== revision) {
    seenRevision = revision;
    invalidate();
  }
  $: if (mounted && `${bundleName}\n${path}\n${file}` !== seen) {
    seen = `${bundleName}\n${path}\n${file}`;
    filter = "";
    void revealLocation();
  }
  async function load(bundle: string, directory: string, force = false) {
    const id = directoryKey(bundle, directory);
    if (requests.has(id)) return requests.get(id);
    if (!force && listings.has(id)) return;
    const requestGeneration = generation,
      signal = controller.signal;
    loading = new Set([...loading, id]);
    errors.delete(id);
    errors = new Map(errors);
    const request = (async () => {
      try {
        const result = await libraryRead<FileListing>(
          "/bundles/files",
          { bundle, path: directory, ...(showHidden ? { hidden: "1" } : {}) },
          signal,
        );
        if (signal.aborted || requestGeneration !== generation) return;
        listings = new Map(listings).set(id, result);
      } catch (cause) {
        if (!signal.aborted && requestGeneration === generation) {
          errors = new Map(errors).set(id, (cause as Error).message);
          notice = `Could not open ${directory || bundle}: ${(cause as Error).message}`;
        }
      } finally {
        if (requestGeneration === generation) {
          loading.delete(id);
          loading = new Set(loading);
          requests.delete(id);
        }
      }
    })();
    requests.set(id, request);
    return request;
  }
  async function revealLocation() {
    if (!bundleName || !names.includes(bundleName)) return;
    const requested = seen;
    for (const ancestor of ancestorPaths(path)) {
      expanded = new Set([...expanded, directoryKey(bundleName, ancestor)]);
      await load(bundleName, ancestor);
      if (requested !== seen) return;
    }
    focused = selectedKey;
    await tick();
    const selected = [...(tree?.querySelectorAll<HTMLButtonElement>("[role=treeitem]") ?? [])].find(
      (el) => el.dataset.key === focused,
    );
    selected?.scrollIntoView({ block: "nearest" });
    if (!documentOpen && file) {
      const row = contentPane?.querySelector<HTMLElement>("tr.selected");
      row?.scrollIntoView({ block: "nearest" });
      row?.querySelector<HTMLButtonElement>(".file-link")?.focus({ preventScroll: true });
    }
    if (restoreLocation === requested && treePane) treePane.scrollTop = viewState.scroll ?? 0;
    restoreLocation = undefined;
  }
  function invalidate() {
    const visibleDirectories = [...listings.values()].filter((directory) =>
      expanded.has(directoryKey(directory.bundle, directory.path)),
    );
    generation++;
    controller.abort();
    controller = new AbortController();
    requests = new Map();
    listings = new Map();
    errors = new Map();
    loading = new Set();
    // Refresh only directories the user already opened. Keep their visible
    // branches useful after a source save without enumerating new subtrees.
    for (const directory of visibleDirectories) void load(directory.bundle, directory.path);
    void revealLocation();
  }
  async function toggle(node: TreeNode) {
    if (node.kind !== "directory" || node.unavailable) return;
    if (expanded.has(node.key)) expanded.delete(node.key);
    else expanded.add(node.key);
    expanded = new Set(expanded);
    focused = node.key;
    if (expanded.has(node.key)) await load(node.bundle, node.path);
    await focus(node.key);
  }
  async function focus(id: string) {
    focused = id;
    await tick();
    const item = [...(tree?.querySelectorAll<HTMLButtonElement>("[role=treeitem]") ?? [])].find(
      (el) => el.dataset.key === id,
    );
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function open(bundle: string, entry: FileEntry) {
    showTree = false;
    dispatch(
      "navigate",
      entry.kind === "directory" && !entry.unavailable
        ? { bundle, path: entry.path }
        : {
            bundle,
            path: parentPath(entry.path),
            file: entry.path,
            open: true,
            ...(entry.assets.length === 1 && !entry.unavailable ? { ref: entry.assets[0].ref } : {}),
          },
    );
  }
  function entryKind(entry: FileEntry) {
    if (entry.kind === "directory") return "Folder";
    if (entry.kind === "other") return "Other";
    const types = [...new Set(entry.assets.map((asset) => asset.type).filter(Boolean))];
    return types.length === 1
      ? types[0][0].toUpperCase() + types[0].slice(1)
      : entry.name.endsWith(".md")
        ? "Markdown"
        : "File";
  }
  async function treeKey(event: KeyboardEvent, node: TreeNode) {
    const index = nodes.findIndex((item) => item.key === node.key);
    let target: TreeNode | undefined;
    if (event.key === "ArrowDown") target = nodes[Math.min(nodes.length - 1, index + 1)];
    else if (event.key === "ArrowUp") target = nodes[Math.max(0, index - 1)];
    else if (event.key === "Home") target = nodes[0];
    else if (event.key === "End") target = nodes.at(-1);
    else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (node.kind === "directory") {
        if (!expanded.has(node.key)) await toggle(node);
        else if (nodes[index + 1]?.parentKey === node.key) await focus(nodes[index + 1].key);
      }
      return;
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.kind === "directory" && expanded.has(node.key)) await toggle(node);
      else if (node.parentKey) await focus(node.parentKey);
      return;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(node.bundle, node);
      return;
    }
    if (target) {
      event.preventDefault();
      await focus(target.key);
    }
  }
  onMount(() => {
    mounted = true;
    if (!focused) focused = names[0] ? directoryKey(names[0], "") : "";
  });
  onDestroy(() => {
    controller.abort();
    Object.assign(viewState, {
      listings,
      expanded,
      focused,
      showHidden,
      location: seen,
      scroll: treePane?.scrollTop ?? 0,
      revision,
    });
  });
</script>

<div class="files-workspace" class:tree-open={showTree}>
  <aside class="files-tree-pane" aria-label="Bundle navigation">
    <div class="tree-heading">
      <span>Bundles & folders</span><button class="quiet mobile-control" on:click={() => (showTree = false)}
        ><Icon name="close" size={16} />Close</button
      >
    </div>
    <div class="tree-scroll" bind:this={treePane}>
      <div role="tree" aria-label="Bundle files" bind:this={tree}>
        {#each nodes as node (node.key)}
          <button
            role="treeitem"
            data-key={node.key}
            aria-level={node.level}
            aria-posinset={node.position}
            aria-setsize={node.size}
            aria-selected={selectedKey === node.key}
            aria-expanded={node.kind === "directory" ? expanded.has(node.key) : undefined}
            aria-busy={loading.has(node.key) || undefined}
            tabindex={focusKey === node.key ? 0 : -1}
            style:padding-left={`${8 + (node.level - 1) * 14}px`}
            on:focus={() => (focused = node.key)}
            on:keydown={(event) => treeKey(event, node)}
            on:click={(event) => {
              if ((event.target as Element).closest("[data-expander]")) void toggle(node);
              else open(node.bundle, node);
            }}
            title={node.unavailable || node.path || node.name}
          >
            <span class="twisty" data-expander aria-hidden="true"
              >{#if node.kind === "directory"}<Icon
                  name={expanded.has(node.key) ? "chevron-down" : "chevron-right"}
                  size={14}
                />{/if}</span
            >
            <Icon name={node.kind === "directory" ? "folder" : "file"} size={16} />
            <span class="node-name">{node.name}</span>{#if node.unavailable}<span
                class="unavailable-dot"
                aria-label="Unavailable"
              ></span>{/if}
          </button>
        {/each}
      </div>
      {#if !names.length}<p class="muted small">No enabled bundles.</p>{/if}
      <p class="sr-only" role="status">{notice}</p>
    </div>
    <label class="hidden-files"
      ><input type="checkbox" bind:checked={showHidden} on:change={invalidate} /> Show hidden entries</label
    >
  </aside>
  <div class="files-main">
    <div class="files-location">
      <button
        class="quiet mobile-control"
        on:click={() => {
          showTree = true;
          void focus(focused || selectedKey);
        }}><Icon name="folder" size={18} />Folders</button
      >
      <nav aria-label="File location" class="file-breadcrumbs">
        {#if bundleName}<button
            on:click={() => dispatch("navigate", { bundle: bundleName, path: "" })}
            aria-current={!path && !documentOpen ? "location" : undefined}>{bundleName}</button
          >{/if}
        {#each path.split("/").filter(Boolean) as part, index}<Icon name="chevron-right" size={14} /><button
            on:click={() =>
              dispatch("navigate", {
                bundle: bundleName,
                path: path
                  .split("/")
                  .slice(0, index + 1)
                  .join("/"),
              })}
            aria-current={index === path.split("/").length - 1 && !documentOpen ? "location" : undefined}>{part}</button
          >{/each}
        {#if documentOpen && file}<Icon name="chevron-right" size={14} /><span aria-current="location"
            >{file.split("/").at(-1)}</span
          >{/if}
      </nav>
      <slot name="actions" />
    </div>
    <div class="files-content" bind:this={contentPane}>
      {#if locationError}<section class="folder-content">
          <h1>Files</h1>
          <p role="status">{locationError}</p>
          <p>
            {names.length
              ? "Choose an enabled bundle in the tree, or check your bundle settings."
              : "Add or enable a bundle to browse its folders and files."}
          </p>
          <a href="/settings/bundles">Bundle settings</a>
        </section>
      {:else if documentOpen}<slot
          {selectedFile}
          indexAvailable={listing?.indexAvailable}
          loading={loading.has(key) || (!listing && !errors.has(key))}
          error={errors.get(key)}
        />
      {:else if !bundleName}<section class="folder-content">
          <h1>Files</h1>
          <p>Select a bundle to browse its folders.</p>
        </section>
      {:else if errors.has(key)}<section class="folder-content">
          <p role="alert">{errors.get(key)}</p>
          <button class="btn-secondary" on:click={() => load(bundleName, path, true)}>Retry folder</button>
        </section>
      {:else if loading.has(key) && !listing}<p class="folder-content" role="status">Loading folder…</p>
      {:else}<section class="folder-content" aria-label="Folder contents" aria-busy={loading.has(key)}>
          <div class="folder-heading">
            <div>
              <h1>{path.split("/").at(-1) || bundleName}</h1>
              <p class="muted small">
                {visibleEntries.length}{filter ? ` of ${listing?.entries.length ?? 0}` : ""} items
              </p>
            </div>
            <div class="folder-tools">
              <button class="quiet" on:click={() => dispatch("search", bundleName)}
                ><Icon name="search" size={16} />Search this bundle</button
              ><input
                type="search"
                bind:value={filter}
                aria-label="Filter this folder"
                placeholder="Filter this folder"
              />
            </div>
          </div>
          {#if listing && !listing.indexAvailable}<p class="notice">
              The index is unavailable. Files are listed, but asset identities cannot be checked.
            </p>{/if}
          <table class="folder-table" class:with-status={showStatus}>
            <thead
              ><tr
                ><th>Name</th><th>Kind</th>{#if showStatus}<th>Status</th>{/if}</tr
              ></thead
            ><tbody>
              {#each visibleEntries as entry (entry.path)}<tr class:selected={entry.path === file}
                  ><td
                    ><div class="entry-name">
                      {#if comparisonMode && entry.assets.length === 1}<input
                          type="checkbox"
                          aria-label={`Compare ${entry.name}`}
                          checked={selectedCompare.includes(entry.assets[0].ref)}
                          disabled={selectedCompare.length === 2 && !selectedCompare.includes(entry.assets[0].ref)}
                          on:change={() => dispatch("select", entry.assets[0].ref)}
                        />{/if}
                      <button class="file-link" on:click={() => open(bundleName, entry)}
                        ><Icon name={entry.kind === "directory" ? "folder" : "file"} size={16} /><span
                          >{entry.name}</span
                        >{#if entry.symlink}<Icon name="external" size={14} />{/if}</button
                      >
                    </div>
                  </td><td>{entryKind(entry)}</td>{#if showStatus}<td class="entry-status"
                      >{#if entry.unavailable}Unavailable{:else if entry.kind !== "directory"}{#if !listing?.indexAvailable}Not
                          checked{:else if entry.assets.length > 1}{entry.assets.length} assets{:else if !entry.assets.length}Not
                          indexed{:else}<span class="sr-only">Indexed</span>{/if}{/if}</td
                    >{/if}</tr
                >{/each}
            </tbody>
          </table>
          {#if !visibleEntries.length}<p class="muted">
              {filter ? "No files match this filter." : "This folder is empty."}
            </p>{/if}
        </section>{/if}
    </div>
  </div>
</div>

<style>
  .files-workspace {
    display: grid;
    grid-template-columns: 236px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    min-width: 0;
    border-top: 1px solid var(--border);
  }
  .files-tree-pane {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    background: var(--surface-2);
    border-right: 1px solid var(--border);
    padding: 0 8px;
  }
  .tree-scroll {
    position: relative;
    min-height: 0;
    flex: 1;
    overflow: auto;
    scrollbar-gutter: stable;
    padding-block: 4px;
  }
  .tree-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: none;
    min-height: 56px;
    padding: 8px 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  [role="treeitem"] {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 34px;
    padding: 5px 8px;
    border: 0;
    background: none;
    color: var(--text);
    text-align: left;
    font-size: 12px;
    font-weight: 400;
    border-radius: 4px;
  }
  [role="treeitem"]:hover {
    background: var(--surface);
  }
  [role="treeitem"][aria-selected="true"] {
    background: var(--accent-bg);
    color: var(--accent);
  }
  [role="treeitem"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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
  .hidden-files {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    margin: 0;
    padding: 14px 10px;
    font-size: 12px;
    color: var(--muted);
    border-top: 1px solid var(--border);
  }
  .files-main {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface);
  }
  .files-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
  }
  .files-location {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 8px 24px;
    min-height: 56px;
    border-bottom: 1px solid var(--border);
  }
  .file-breadcrumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
    font-size: 13px;
  }
  .file-breadcrumbs button {
    border: 0;
    background: none;
    color: var(--muted);
    padding: 3px 2px;
    min-height: 28px;
    font-size: 13px;
    font-weight: 400;
  }
  .file-breadcrumbs [aria-current] {
    color: var(--text);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .folder-content {
    padding: 24px 28px;
    margin: 0;
  }
  .folder-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 24px;
  }
  .folder-heading h1 {
    font-size: 22px;
    margin: 0;
  }
  .folder-heading p {
    margin: 4px 0 0;
  }
  .folder-tools {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .folder-heading input {
    flex: none;
    max-width: 200px;
    min-width: 0;
    height: var(--control-height, 40px);
    font-size: 13px;
  }
  .folder-table {
    width: 100%;
    table-layout: fixed;
  }
  .folder-table th:first-child {
    width: 70%;
  }
  .folder-table.with-status th:first-child {
    width: 60%;
  }
  .folder-table th {
    font-size: 12px;
    padding: 10px 12px;
    background: none;
    color: var(--muted);
  }
  .folder-table td {
    position: relative;
    font-size: 12px;
    padding: 2px 12px;
    vertical-align: middle;
    border-bottom-color: var(--border);
  }
  .folder-table td:first-child,
  .folder-table th:first-child {
    padding-left: 0;
  }
  .folder-table tbody tr:hover {
    background: var(--surface-2);
  }
  .folder-table tr.selected {
    background: var(--accent-bg);
  }
  .entry-name {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .file-link {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .file-link span {
    flex: 1;
    min-width: 0;
  }
  .file-link:hover {
    color: var(--accent);
  }
  .entry-status {
    color: var(--muted);
  }
  .quiet {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 0;
    background: none;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
  }
  .mobile-control {
    display: none;
  }
  @media (max-width: 1000px) {
    .folder-tools {
      flex-direction: column;
      align-items: end;
      gap: 4px;
    }
  }
  @media (max-width: 850px) {
    .files-workspace {
      display: block;
    }
    .files-tree-pane {
      display: none;
    }
    .files-main {
      height: 100%;
    }
    .tree-open .files-tree-pane {
      display: flex;
      height: calc(100dvh - 210px);
      min-height: 280px;
      border: 0;
    }
    .tree-open .files-main {
      display: none;
    }
    .mobile-control {
      display: inline-flex;
    }
    .files-location {
      padding: 8px 16px;
    }
    .file-breadcrumbs button {
      min-height: var(--control-height, 44px);
    }
    .file-breadcrumbs {
      order: 2;
      flex-basis: 100%;
    }
    .folder-content {
      padding: 24px 20px;
    }
    .folder-heading {
      flex-wrap: wrap;
      gap: 16px;
    }
    .folder-tools {
      width: 100%;
      align-items: stretch;
    }
    .folder-tools .quiet {
      align-self: start;
      padding-inline: 0;
    }
    .folder-heading input {
      max-width: none;
      width: 100%;
    }
    .folder-table td {
      padding-block: 0;
    }
    .folder-table th:nth-child(2),
    .folder-table td:nth-child(2) {
      display: none;
    }
    .folder-table th:first-child {
      width: 100%;
    }
    .folder-table.with-status th:first-child {
      width: 72%;
    }
    [role="treeitem"] {
      min-height: 44px;
      font-size: 14px;
    }
  }
</style>
