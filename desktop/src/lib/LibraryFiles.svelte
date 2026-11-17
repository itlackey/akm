<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, onMount, tick, untrack, type Snippet } from "svelte";
  import { api } from "./client";
  import { ancestorPaths, directoryKey, followMove, parentPath, sizeText } from "./library-files-model";
  import type {
    FileActions,
    FileEntry,
    FileListing,
    FileLocation,
    FileRequest,
    FilesViewState,
  } from "./library-files-model";
  import { FileTreeState } from "./file-tree-state.svelte";
  import { refreshBundles, workspace } from "./state/workspace.svelte";
  import type { Bundle, Retirement } from "./types";
  import FileDialog from "./FileDialog.svelte";
  import FileMenu from "./FileMenu.svelte";
  import FileTree from "./FileTree.svelte";
  import Icon from "./Icon.svelte";
  let {
    bundles = [],
    bundleName = "",
    path = "",
    file = "",
    documentOpen = false,
    revision = 0,
    comparisonMode = false,
    selectedCompare = [],
    viewState = {},
    onNavigate,
    onSelect,
    onSearch,
    onChanged,
    onCreated,
    actions,
    children,
  }: {
    bundles?: Bundle[];
    bundleName?: string;
    path?: string;
    file?: string;
    documentOpen?: boolean;
    revision?: number;
    comparisonMode?: boolean;
    selectedCompare?: string[];
    /** What the tree looked like when Files was last left; this view writes its own state back when it goes. */
    viewState?: FilesViewState;
    onNavigate?: (location: FileLocation) => void;
    onSelect?: (ref: string) => void;
    onSearch?: (bundle: string) => void;
    /** A file operation finished; `moved` carries akm's answer to a move, a rename or a copy. */
    onChanged?: (change?: { moved?: Record<string, unknown> }) => void;
    /** A new file was made: it opens in the editor. */
    onCreated?: (created: { bundle: string; folder: string; file: string; ref: string | null }) => void;
    /** Links and buttons at the end of the location bar. */
    actions?: Snippet;
    /** The open document, with what the folder listing knows about its file. */
    children?: Snippet<[{ selectedFile?: FileEntry; indexAvailable?: boolean; loading: boolean; error?: string }]>;
  } = $props();
  // Read once, as this view starts: what the last Files view left behind, and the revision it starts from.
  const kept = untrack(() => viewState),
    startRevision = untrack(() => revision);
  const tree = new FileTreeState({
    listings: kept.revision === startRevision ? kept.listings : undefined,
    expanded: kept.expanded,
    showHidden: kept.showHidden,
  });
  let seen = "",
    seenRevision = startRevision;
  let focused = $state(kept.focused ?? ""),
    fileTree = $state<ReturnType<typeof FileTree>>(),
    treePane = $state<HTMLElement>(),
    contentPane = $state<HTMLElement>(),
    foldersButton = $state<HTMLButtonElement>(),
    filter = $state(""),
    showTree = $state(false),
    showHidden = $state(kept.showHidden ?? false),
    notice = $state(""),
    failure = $state("");
  let menu = $state<{
      bundle: string;
      path: string;
      name: string;
      actions?: FileActions;
      folder?: FileListing;
      at: { x: number; y: number } | null;
      origin: HTMLElement;
    } | null>(null),
    request = $state<FileRequest | null>(null),
    requestOrigin: HTMLElement | undefined,
    renaming = $state<{ bundle: string; path: string } | null>(null),
    dragging = $state<{ bundle: string; path: string; name: string; actions: FileActions } | null>(null),
    dropKey = $state("");
  let committing = $state(false),
    committed = $state<{
      committed: boolean;
      pushed: boolean;
      commit?: string;
      output: string;
      reason?: string;
    } | null>(null),
    commitFailure = $state("");
  let creating = $state<{ kind: "new-file" | "new-folder"; bundle: string; path: string } | null>(null),
    createName = $state(""),
    createBusy = $state(false);
  let restoreLocation = kept.location;
  const names = $derived(bundles.filter((b) => b.enabled).map((b) => b.name));
  const key = $derived(directoryKey(bundleName, path));
  const listing = $derived(tree.listings.get(key));
  const selectedKey = $derived(directoryKey(bundleName, file || path));
  const selectedFile = $derived(listing?.entries.find((entry) => entry.path === file));
  const locationError = $derived(
    !names.length
      ? "No enabled bundles are available in Files."
      : bundleName && !names.includes(bundleName)
        ? "This bundle is disabled or no longer configured."
        : "",
  );
  const visibleEntries = $derived(
    (listing?.entries ?? []).filter(
      (entry) => !filter || entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ),
  );
  const showStatus = $derived(
    listing?.entries.some(
      (entry) =>
        entry.unavailable || (entry.kind !== "directory" && (!listing.indexAvailable || entry.assets.length !== 1)),
    ) ?? false,
  );
  const git = $derived(bundles.find((entry) => entry.name === bundleName)?.git);
  const newFile = $derived(listing?.newFile);
  const newPlace = $derived(listing?.place);
  const createLabel = $derived(
    creating?.kind === "new-folder" ? "Name of the new folder" : `Name of the new ${listing?.newFile.type ?? "file"}`,
  );
  // A new location is revealed in the tree, and the folder filter starts empty again.
  $effect(() => {
    const location = `${bundleName}\n${path}\n${file}`;
    if (location === seen) return;
    seen = location;
    filter = "";
    untrack(() => void revealLocation());
  });
  // The files changed: the folders already opened are read again.
  $effect(() => {
    if (seenRevision === revision) return;
    seenRevision = revision;
    untrack(invalidate);
  });
  // A failed read of the folder shown is announced where the person is.
  $effect(() => {
    const message = tree.errors.get(key);
    if (message) notice = `Could not open ${path || bundleName}: ${message}`;
  });
  async function revealLocation() {
    if (!bundleName || !names.includes(bundleName)) return;
    const requested = seen;
    for (const ancestor of ancestorPaths(path)) {
      await tree.open(directoryKey(bundleName, ancestor), bundleName, ancestor);
      if (requested !== seen) return;
    }
    focused = selectedKey;
    await tick();
    const selected = [...(fileTree?.container()?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])].find(
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
    tree.showHidden = showHidden;
    void tree.invalidate();
    void revealLocation();
  }
  /** Close the folder drawer a phone shows in place of the page; focus goes back to the button that opened it. */
  async function closeTree() {
    showTree = false;
    await tick();
    foldersButton?.focus();
  }
  function drawerKey(event: KeyboardEvent) {
    if (event.key === "Escape" && showTree && !event.defaultPrevented) void closeTree();
  }
  function open(bundle: string, entry: Pick<FileEntry, "kind" | "path" | "unavailable" | "assets">) {
    showTree = false;
    onNavigate?.(
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
  function focusName(input: HTMLInputElement) {
    input.focus();
    input.setSelectionRange(0, input.value.includes(".") ? input.value.lastIndexOf(".") : input.value.length);
  }
  const modifiedText = (value?: string) => (value ? new Date(value).toLocaleString() : "");
  function entryOf(node: { bundle: string; path: string }) {
    return tree.listings
      .get(directoryKey(node.bundle, parentPath(node.path)))
      ?.entries.find((entry) => entry.path === node.path);
  }
  // The menu: akm's verdicts for the entry, and for a folder the verdicts for what could be made in it.
  async function openMenu(
    target: { bundle: string; path: string; name: string; kind: string; actions?: FileActions; root?: boolean },
    at: { x: number; y: number } | null,
    origin: HTMLElement,
  ) {
    const isFolder = target.kind === "directory";
    if (isFolder) await tree.load(target.bundle, target.path);
    menu = {
      bundle: target.bundle,
      path: target.path,
      name: target.name,
      actions: target.root ? undefined : target.actions,
      folder: isFolder ? tree.listings.get(directoryKey(target.bundle, target.path)) : undefined,
      at,
      origin,
    };
  }
  async function closeMenu(restore = true) {
    const origin = menu?.origin;
    menu = null;
    await tick();
    if (restore && origin?.isConnected) origin.focus();
  }
  async function choose(action: string) {
    const target = menu;
    if (!target) return;
    requestOrigin = target.origin;
    menu = null;
    const allowed = target.actions;
    if (action === "rename") renaming = { bundle: target.bundle, path: target.path };
    else if (action === "move" || action === "copy" || action === "delete") {
      if (!allowed) return;
      request = {
        kind: action,
        bundle: target.bundle,
        path: target.path,
        name: target.name,
        actions: allowed,
        destination: { bundle: target.bundle, path: parentPath(target.path) },
      };
    } else if (action === "retire") await retire(target.bundle, target.path);
    else if (action === "reveal") await reveal(target.bundle, target.path);
    else if (action === "new-file" || action === "new-folder") startCreate(action, target.bundle, target.path);
  }
  async function renameTo(node: { bundle: string; path: string; name: string }, name: string) {
    renaming = null;
    if (!name || name === node.name) return;
    failure = "";
    try {
      const result = await api<Record<string, unknown>>(
        "/desktop/files/move",
        {},
        { bundle: node.bundle, from: node.path, folder: parentPath(node.path), name },
      );
      moved(node, result, `Renamed ${node.name} to ${name}.`);
    } catch (cause) {
      failure = (cause as Error).message;
    }
  }
  /** A move, rename or copy happened: follow the open file to its new place and say what akm did. */
  function moved(
    node: { bundle: string; path: string; name: string },
    result: Record<string, unknown>,
    message: string,
    follow = true,
  ) {
    notice = message;
    if (result.indexError) failure = `The change was made, but akm could not index it: ${result.indexError}`;
    else if (Array.isArray(result.warnings) && result.warnings.length) failure = result.warnings.join(" ");
    const to = String(result.to ?? ""),
      toBundle = String(result.toBundle ?? node.bundle);
    const next = follow && bundleName === node.bundle ? followMove(file, node.path, to) : null;
    onChanged?.({ moved: result });
    if (next !== null && file) {
      const assets = (result.assets as FileEntry["assets"] | undefined) ?? [];
      onNavigate?.({
        bundle: toBundle,
        path: parentPath(next),
        file: next,
        open: true,
        ...(assets.length === 1 && next === to ? { ref: assets[0].ref } : {}),
      });
    }
  }
  async function retire(bundle: string, filePath: string) {
    failure = "";
    const entry = entryOf({ bundle, path: filePath });
    if (!entry) return;
    if (entry.assets.length !== 1) {
      failure = `${entry.name} holds ${entry.assets.length} assets: open one and retire it from its page.`;
      return;
    }
    try {
      const ref = entry.assets[0].ref;
      const { revision: current } = await api<{ revision: string }>("/desktop/file", { ref });
      const receipt = await api<Retirement>("/asset/retire", {}, { ref, revision: current });
      notice = `Retired ${entry.name}. Restore it from Review (proposal ${receipt.proposalId}).`;
      onChanged?.();
      if (file === filePath) onNavigate?.({ bundle, path: parentPath(filePath) });
    } catch (cause) {
      failure = (cause as Error).message;
    }
  }
  async function reveal(bundle: string, filePath: string) {
    failure = "";
    try {
      await api("/desktop/files/reveal", {}, { bundle, path: filePath });
    } catch (cause) {
      failure = (cause as Error).message;
    }
  }
  async function requestDone(
    done: FileRequest,
    result: Record<string, unknown>,
    destination: { bundle: string; path: string },
  ) {
    request = null;
    failure = "";
    if (done.kind === "delete") {
      notice = `Deleted ${done.name}.`;
      onChanged?.();
      if (followMove(file, done.path, "") !== null) onNavigate?.({ bundle: done.bundle, path: parentPath(done.path) });
    } else {
      const where = destination.path || destination.bundle;
      moved(
        done,
        result,
        done.kind === "copy" ? `Copied ${done.name} to ${where}.` : `Moved ${done.name} to ${where}.`,
        done.kind !== "copy",
      );
    }
    await tick();
    if (requestOrigin?.isConnected) requestOrigin.focus();
  }
  async function cancelRequest() {
    request = null;
    await tick();
    if (requestOrigin?.isConnected) requestOrigin.focus();
  }
  // Drag: a file or folder dropped on a folder asks once, naming both; "Move to…" is the same without a pointer.
  const movable = (node: { actions?: FileActions }) => node.actions?.move.allowed === true;
  function startDrag(node: { bundle: string; path: string; name: string; actions?: FileActions }, event: DragEvent) {
    if (!node.actions) return;
    dragging = { bundle: node.bundle, path: node.path, name: node.name, actions: node.actions };
    event.dataTransfer?.setData("text/plain", node.name);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  function dropOnto(target: { bundle: string; path: string; kind: string }, event: DragEvent, over: boolean) {
    // A folder cannot go into itself, and dropping an entry on the folder it is in changes nothing.
    if (!dragging || target.kind !== "directory") return;
    if (
      dragging.bundle === target.bundle &&
      (followMove(target.path, dragging.path, "") !== null || parentPath(dragging.path) === target.path)
    )
      return;
    event.preventDefault();
    if (over) {
      dropKey = directoryKey(target.bundle, target.path);
      return;
    }
    const dropped = dragging;
    dragging = null;
    dropKey = "";
    requestOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    request = {
      kind: "drop",
      bundle: dropped.bundle,
      path: dropped.path,
      name: dropped.name,
      actions: dropped.actions,
      destination: { bundle: target.bundle, path: target.path },
    };
  }
  function endDrag() {
    dragging = null;
    dropKey = "";
  }
  /** Commit the bundle as `akm sync` does: nothing commits unless this is chosen. */
  async function commitBundle() {
    if (committing) return;
    committing = true;
    committed = null;
    commitFailure = "";
    try {
      committed = await api("/bundles/commit", {}, { bundle: bundleName });
      await refreshBundles();
    } catch (cause) {
      commitFailure = (cause as Error).message;
    } finally {
      committing = false;
    }
  }
  // New file and new folder: a name for what is made in the folder shown.
  function startCreate(kind: "new-file" | "new-folder", bundle: string, folder: string) {
    creating = { kind, bundle, path: folder };
    createName = "";
    if (bundle !== bundleName || folder !== path) onNavigate?.({ bundle, path: folder });
  }
  async function create() {
    if (!creating || createBusy || !createName.trim()) return;
    createBusy = true;
    failure = "";
    const made = creating;
    try {
      if (made.kind === "new-folder") {
        await api("/desktop/files/folder", {}, { bundle: made.bundle, folder: made.path, name: createName.trim() });
        notice = `Created folder ${createName.trim()}.`;
        creating = null;
        onChanged?.();
      } else {
        const result = await api<{ ref: string | null; file: string }>(
          "/documents/create-file",
          {},
          { bundle: made.bundle, folder: made.path, name: createName.trim() },
        );
        creating = null;
        onChanged?.();
        onCreated?.({ bundle: made.bundle, folder: made.path, file: result.file, ref: result.ref });
      }
    } catch (cause) {
      failure = (cause as Error).message;
    } finally {
      createBusy = false;
    }
  }
  onMount(() => {
    if (!focused) focused = names[0] ? directoryKey(names[0], "") : "";
  });
  onDestroy(() => {
    tree.abort();
    Object.assign(viewState, {
      listings: tree.listings,
      expanded: tree.expanded,
      focused,
      showHidden,
      location: seen,
      scroll: treePane?.scrollTop ?? 0,
      revision,
    });
  });
</script>

<svelte:window onkeydown={drawerKey} />
<div class="files-workspace" class:tree-open={showTree}>
  <aside class="files-tree-pane" aria-label="Bundle navigation">
    <div class="tree-heading">
      <span>Bundles & folders</span><button class="quiet mobile-control" onclick={closeTree}
        ><Icon name="close" size={16} />Close</button
      >
    </div>
    <div class="tree-scroll" bind:this={treePane}>
      <FileTree
        bind:this={fileTree}
        bundles={names}
        {tree}
        label="Bundle files"
        {selectedKey}
        bind:focused
        {renaming}
        {dropKey}
        onOpen={(node) => open(node.bundle, node)}
        onMenu={(node, at, origin) => openMenu(node, at, origin)}
        onBeginRename={(node) => node.actions?.move.allowed && (renaming = { bundle: node.bundle, path: node.path })}
        onRename={(node, name) => renameTo(node, name)}
        onCancelRename={() => (renaming = null)}
        canDrag={movable}
        onDragStart={startDrag}
        onDragEnd={endDrag}
        onDragOver={(node, event) => dropOnto(node, event, true)}
        onDrop={(node, event) => dropOnto(node, event, false)}
      />
      {#if !names.length}<p class="muted small">No enabled bundles.</p>{/if}
      <p class="sr-only" role="status">{notice}</p>
    </div>
    <label class="hidden-files"
      ><input type="checkbox" bind:checked={showHidden} onchange={invalidate} /> Show hidden entries</label
    >
  </aside>
  <div class="files-main">
    <div class="files-location">
      <button
        class="quiet mobile-control"
        bind:this={foldersButton}
        onclick={() => {
          showTree = true;
          void fileTree?.focus(focused || selectedKey);
        }}><Icon name="folder" size={18} />Folders</button
      >
      <nav aria-label="File location" class="file-breadcrumbs">
        {#if bundleName}<button
            onclick={() => onNavigate?.({ bundle: bundleName, path: "" })}
            aria-current={!path && !documentOpen ? "location" : undefined}>{bundleName}</button
          >{/if}
        {#each path.split("/").filter(Boolean) as part, index}<Icon name="chevron-right" size={14} /><button
            onclick={() =>
              onNavigate?.({
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
      {@render actions?.()}
    </div>
    {#if git}<section class="bundle-git" aria-label={`Git for ${bundleName}`}>
        {#if git.error}<span role="alert">Git could not be read: {git.error}</span>
        {:else}<span
            >{git.uncommitted === null || git.uncommitted === undefined
              ? "Uncommitted files: unknown, akm could not list the changes."
              : `${git.uncommitted} ${git.uncommitted === 1 ? "file" : "files"} uncommitted`}</span
          ><button
            class="btn btn-secondary"
            aria-disabled={committing ? "true" : undefined}
            aria-busy={committing || undefined}
            onclick={commitBundle}>{committing ? "Committing…" : "Commit"}</button
          >{/if}
        {#if committed}<span role="status" class="muted small"
            >{committed.committed
              ? `Committed ${committed.commit ?? ""}${committed.pushed ? " and pushed." : "."}`
              : `Nothing was committed${committed.reason ? `: ${committed.reason}` : "."}`}
            <span class="mono wrap">{committed.output}</span></span
          >{/if}
        {#if commitFailure}<span role="alert">The commit failed: {commitFailure}</span>{/if}
      </section>{/if}
    {#if failure}<p class="notice notice-warn files-failure" role="alert">{failure}</p>{/if}
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
      {:else if documentOpen}{@render children?.({
          selectedFile,
          indexAvailable: listing?.indexAvailable,
          loading: tree.loading.has(key) || (!listing && !tree.errors.has(key)),
          error: tree.errors.get(key),
        })}
      {:else if !bundleName}<section class="folder-content">
          <h1>Files</h1>
          <p>Select a bundle to browse its folders.</p>
        </section>
      {:else if tree.errors.has(key)}<section class="folder-content">
          <p role="alert">{tree.errors.get(key)}</p>
          <button class="btn-secondary" onclick={() => tree.load(bundleName, path, true)}>Retry folder</button>
        </section>
      {:else if !listing}<p class="folder-content" role="status">Loading folder…</p>
      {:else}<section class="folder-content" aria-label="Folder contents" aria-busy={tree.loading.has(key)}>
          <div class="folder-heading">
            <div>
              <h1>{path.split("/").at(-1) || bundleName}</h1>
              <p class="muted small">
                {visibleEntries.length}{filter ? ` of ${listing?.entries.length ?? 0}` : ""} items
              </p>
            </div>
            <div class="folder-tools">
              <button class="quiet" onclick={() => onSearch?.(bundleName)}
                ><Icon name="search" size={16} />Search this bundle</button
              ><label class="folder-filter">Filter this folder<input type="search" bind:value={filter} /></label>
            </div>
          </div>
          {#if listing && !listing.indexAvailable}<p class="notice">
              The index is unavailable. Files are listed, but asset identities cannot be checked.
            </p>{/if}
          <div class="folder-new">
            <button
              class="btn btn-secondary"
              aria-disabled={newFile?.allowed ? undefined : "true"}
              aria-describedby={newFile?.allowed ? undefined : "new-file-reason"}
              onclick={() => newFile?.allowed && startCreate("new-file", bundleName, path)}
              ><Icon name="plus" size={16} />{newFile?.type ? `New ${newFile.type}` : "New file"}</button
            ><button
              class="btn btn-secondary"
              aria-disabled={newPlace?.allowed ? undefined : "true"}
              aria-describedby={newPlace?.allowed ? undefined : "new-folder-reason"}
              onclick={() => newPlace?.allowed && startCreate("new-folder", bundleName, path)}>New folder</button
            >
            {#if newFile && !newFile.allowed}<p class="muted small" id="new-file-reason">{newFile.reason}</p>{/if}
            {#if newPlace && !newPlace.allowed}<p class="muted small" id="new-folder-reason">{newPlace.reason}</p>{/if}
          </div>
          {#if creating && creating.bundle === bundleName && creating.path === path}
            <form
              class="create-form"
              onsubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label
                >{createLabel}<input
                  bind:value={createName}
                  aria-busy={createBusy || undefined}
                  onkeydown={(event) => event.key === "Escape" && (creating = null)}
                /></label
              ><button class="btn" aria-disabled={createBusy || !createName.trim() ? "true" : undefined}
                >{createBusy ? "Creating…" : "Create"}</button
              ><button type="button" class="btn-secondary" onclick={() => (creating = null)}>Cancel</button>
            </form>
          {/if}
          <table class="folder-table" class:with-status={showStatus}>
            <thead
              ><tr
                ><th>Name</th><th>Kind</th><th class="num">Size</th><th>Modified</th>{#if showStatus}<th>Status</th
                  >{/if}<th class="row-actions"><span class="sr-only">Actions</span></th></tr
              ></thead
            ><tbody>
              {#each visibleEntries as entry (entry.path)}<tr
                  class:selected={entry.path === file}
                  class:drop-target={dropKey === directoryKey(bundleName, entry.path)}
                  draggable={movable(entry) ? "true" : undefined}
                  ondragstart={(event) => startDrag({ bundle: bundleName, ...entry }, event)}
                  ondragend={endDrag}
                  ondragover={(event) => dropOnto({ bundle: bundleName, ...entry }, event, true)}
                  ondrop={(event) => dropOnto({ bundle: bundleName, ...entry }, event, false)}
                  oncontextmenu={(event) => {
                    event.preventDefault();
                    void openMenu(
                      { bundle: bundleName, ...entry },
                      { x: event.clientX, y: event.clientY },
                      event.currentTarget as HTMLElement,
                    );
                  }}
                  ><td
                    ><div class="entry-name">
                      {#if comparisonMode && entry.assets.length === 1}<input
                          type="checkbox"
                          aria-label={`Compare ${entry.name}`}
                          checked={selectedCompare.includes(entry.assets[0].ref)}
                          disabled={selectedCompare.length === 2 && !selectedCompare.includes(entry.assets[0].ref)}
                          onchange={() => onSelect?.(entry.assets[0].ref)}
                        />{/if}
                      {#if renaming?.bundle === bundleName && renaming.path === entry.path}<input
                          class="row-rename"
                          aria-label={`New name for ${entry.name}`}
                          value={entry.name}
                          use:focusName
                          onkeydown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void renameTo({ bundle: bundleName, ...entry }, event.currentTarget.value);
                            } else if (event.key === "Escape") renaming = null;
                          }}
                          onblur={() => (renaming = null)}
                        />{:else}<button class="file-link" onclick={() => open(bundleName, entry)}
                          ><Icon name={entry.kind === "directory" ? "folder" : "file"} size={16} /><span
                            >{entry.name}</span
                          >{#if entry.symlink}<Icon name="external" size={14} />{/if}</button
                        >{/if}
                    </div>
                  </td><td>{entryKind(entry)}</td><td class="num">{sizeText(entry.size)}</td><td
                    >{modifiedText(entry.modified)}</td
                  >{#if showStatus}<td class="entry-status"
                      >{#if entry.unavailable}Unavailable{:else if entry.kind !== "directory"}{#if !listing?.indexAvailable}Not
                          checked{:else if entry.assets.length > 1}{entry.assets.length} assets{:else if !entry.assets.length}Not
                          indexed{:else}<span class="sr-only">Indexed</span>{/if}{/if}</td
                    >{/if}<td class="row-actions"
                    ><button
                      class="quiet"
                      aria-haspopup="menu"
                      aria-label={`Actions for ${entry.name}`}
                      onclick={(event) =>
                        openMenu({ bundle: bundleName, ...entry }, null, event.currentTarget as HTMLElement)}
                      ><Icon name="more" size={16} /></button
                    ></td
                  ></tr
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
{#if menu}<FileMenu
    name={menu.name}
    actions={menu.actions}
    folder={menu.folder}
    at={menu.at}
    origin={menu.origin}
    native={workspace.native}
    onChoose={choose}
    onClose={() => closeMenu(false)}
  />{/if}
{#if request}<FileDialog {request} bundles={names} onDone={requestDone} onCancel={cancelRequest} />{/if}

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
  /* The filter's name is shown: before the field, and above it where the tools stack on a phone. */
  .folder-filter {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
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
    width: 40%;
  }
  .folder-table .num {
    text-align: right;
    white-space: nowrap;
  }
  .folder-table .row-actions {
    width: 48px;
    padding-inline: 0;
    text-align: center;
  }
  .folder-table tr.drop-target {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  .folder-new {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-bottom: 16px;
  }
  .folder-new p {
    flex-basis: 100%;
    margin: 0;
  }
  .create-form {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 8px 12px;
    margin-bottom: 16px;
  }
  .create-form label {
    display: grid;
    gap: 4px;
    font-size: 13px;
    font-weight: 550;
  }
  .bundle-git {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 8px 24px;
    font-size: 13px;
    border-bottom: 1px solid var(--border);
  }
  .files-failure {
    margin: 8px 24px 0;
  }
  .row-rename {
    flex: 1;
    min-width: 0;
    height: 32px;
    font-size: 13px;
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
    /* Beside Folders and before the actions, as in the markup: wide enough that the actions take the next line. */
    .file-breadcrumbs {
      flex-basis: 60%;
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
    .folder-filter {
      display: grid;
      gap: 4px;
    }
    .folder-heading input {
      max-width: none;
      width: 100%;
    }
    .folder-table td {
      padding-block: 0;
    }
    .folder-table th:nth-child(2),
    .folder-table td:nth-child(2),
    .folder-table th:nth-child(3),
    .folder-table td:nth-child(3),
    .folder-table th:nth-child(4),
    .folder-table td:nth-child(4) {
      display: none;
    }
    .folder-table th:first-child {
      width: 100%;
    }
  }
</style>
