<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { tick } from "svelte";
  import {
    draftErrors,
    projectChange,
    projectDraft,
    projectSummary,
    type ProjectDraft,
    type ProjectRow,
  } from "./projects-model";

  let {
    projects,
    bundles,
    warnings,
    busy,
    save,
  }: {
    projects: ProjectRow[];
    bundles: string[];
    warnings: string[];
    busy: boolean;
    /** Writes the change and says whether it was saved; a refusal is shown by the page and the form stays open. */
    save: (body: ReturnType<typeof projectChange> | { unset: string[] }) => Promise<boolean>;
  } = $props();

  // `editing` is the project being edited (null for a new one); `draft` is undefined while the list shows.
  let draft = $state<ProjectDraft | undefined>(undefined),
    editing = $state<ProjectRow | null>(null),
    removing = $state(false),
    heading = $state<HTMLHeadingElement>();

  // A configured bundle the project names that is no longer registered stays selectable, so saving does not drop it.
  const choices = $derived([...new Set([...bundles, ...[editing?.entry.from ?? []].flat(), ...(draft?.from ?? [])])]);
  const errors = $derived(draft ? draftErrors(draft) : []);

  async function open(row: ProjectRow | null) {
    editing = row;
    draft = projectDraft(row?.name ?? "", row?.entry);
    removing = false;
    await tick();
    heading?.focus();
  }
  async function submit() {
    if (draft && !errors.length && (await save(projectChange(draft, editing)))) draft = undefined;
  }
  async function remove() {
    if (editing && (await save({ unset: [editing.name] }))) draft = undefined;
  }
  function toggle(bundle: string, on: boolean) {
    if (draft) draft.from = on ? [...draft.from, bundle] : draft.from.filter((name) => name !== bundle);
  }
</script>

{#snippet scope(rows: ProjectDraft["filters"], label: string, hint: string)}
  <fieldset class="field">
    <legend class="field-label">{label}</legend>
    <p class="field-hint">{hint}</p>
    {#each rows as row, index}
      <div class="scope-row">
        <input bind:value={row.key} placeholder="Key, such as channel" aria-label={`${label} key ${index + 1}`} />
        <textarea
          bind:value={row.values}
          rows="2"
          placeholder="One value per line"
          aria-label={`${label} values ${index + 1}`}></textarea>
        <label class="check-label"
          ><input type="checkbox" bind:checked={row.absent} /> Also when the key is absent</label
        >
        <button
          type="button"
          class="btn-secondary"
          aria-label={`Remove ${label.toLowerCase()} row ${index + 1}`}
          onclick={() => rows.splice(index, 1)}>Remove</button
        >
      </div>
    {/each}
    <div class="btn-row">
      <button type="button" class="btn-secondary" onclick={() => rows.push({ key: "", values: "", absent: false })}
        >Add {label.toLowerCase()} row</button
      >
    </div>
  </fieldset>
{/snippet}

{#if warnings.length}<div class="notice notice-warn" role="status">
    <p>
      akm ignores these parts of the projects in config.json. Saving a project writes it as shown, which clears its
      warnings; an entry akm ignores entirely is not listed, so edit the file to fix it.
    </p>
    <ul>
      {#each warnings as warning}<li>{warning}</li>{/each}
    </ul>
  </div>{/if}
{#if !draft}
  <div class="project-list">
    {#each projects as project (project.name)}
      <article class="card" aria-label={`Project ${project.name}`}>
        <header class="card-head">
          <h3>{project.name}</h3>
          {#if project.inherited}<span class="badge">Inherited</span>{/if}
          <button
            class="btn-secondary"
            disabled={busy}
            onclick={() => open(project)}
            aria-label={`Edit ${project.name}`}>Edit</button
          >
        </header>
        <p class="mono wrap">{project.entry.paths?.join(", ") || "No directories"}</p>
        {#if projectSummary(project.entry).length}<p class="muted small">
            {projectSummary(project.entry).join(" · ")}
          </p>{/if}
      </article>
    {:else}
      <p class="empty">No projects. A project tells akm what to read and write in the directories you work in.</p>
    {/each}
  </div>
  <div class="btn-row">
    <button disabled={busy} onclick={() => open(null)}>Add project</button>
  </div>
{:else}
  <form class="card settings-card" onsubmit={(event) => (event.preventDefault(), submit())}>
    <div class="settings-fields">
      <h3 tabindex="-1" bind:this={heading}>{editing ? `Edit ${editing.name}` : "Add a project"}</h3>
      {#if editing?.inherited}<p class="notice">
          This project comes from a config this one extends. Saving creates a local project of the same name.
        </p>{/if}
      <label class="field">
        <span class="field-label">Name</span>
        <input bind:value={draft.name} required disabled={editing?.inherited} autocomplete="off" spellcheck="false" />
        <span class="field-hint"
          >{editing?.inherited
            ? "An inherited project keeps its name; saving creates a local project of that name."
            : "Renaming a project moves its settings to the new name."}</span
        >
      </label>
      <label class="field">
        <span class="field-label">Directories</span>
        <textarea
          bind:value={draft.paths}
          rows="3"
          placeholder={"~/code/my-project\n/work/my-project"}
          spellcheck="false"></textarea>
        <span class="field-hint">One per line, absolute or starting with ~. The most specific match wins.</span>
      </label>
      <fieldset class="field">
        <legend class="field-label">Bundles to read</legend>
        <p class="field-hint">Search and curate read only these bundles here. None selected reads the usual set.</p>
        {#each choices as bundle (bundle)}
          <label class="check-label"
            ><input
              type="checkbox"
              checked={draft.from.includes(bundle)}
              onchange={(event) => toggle(bundle, event.currentTarget.checked)}
            />
            {bundle}{#if !bundles.includes(bundle)}<span class="muted"> (not registered)</span>{/if}</label
          >
        {/each}
      </fieldset>
      {@render scope(
        draft.filters,
        "Filters",
        "Only assets with one of the values are read. A row without values is left out.",
      )}
      {@render scope(
        draft.prefer,
        "Prefer",
        "Assets with one of the values rank first. Without any, assets marked project=<name> do.",
      )}
      <fieldset class="field">
        <legend class="field-label">Write defaults</legend>
        <p class="field-hint">Applied to new memories and proposals made in these directories.</p>
        <label class="field">
          <span class="field-label">Bundle</span>
          <select bind:value={draft.bundle}>
            <option value="">Automatic</option>
            {#each choices as bundle}<option value={bundle}>{bundle}</option>{/each}
            {#if draft.bundle && !choices.includes(draft.bundle)}<option value={draft.bundle}
                >{draft.bundle} (not registered)</option
              >{/if}
          </select>
        </label>
        <div class="settings-grid">
          <label class="field"><span class="field-label">User</span><input bind:value={draft.user} /></label>
          <label class="field"><span class="field-label">Agent</span><input bind:value={draft.agent} /></label>
          <label class="field"><span class="field-label">Channel</span><input bind:value={draft.channel} /></label>
        </div>
        <div class="field">
          <span class="field-label">Metadata</span>
          <span class="field-hint">Frontmatter keys added to what is written. Empty keys are left out.</span>
          {#each draft.metadata as row, index}
            <div class="scope-row">
              <input bind:value={row.key} placeholder="Key" aria-label={`Metadata key ${index + 1}`} />
              <input bind:value={row.value} placeholder="Value" aria-label={`Metadata value ${index + 1}`} />
              <button
                type="button"
                class="btn-secondary"
                aria-label={`Remove metadata row ${index + 1}`}
                onclick={() => draft?.metadata.splice(index, 1)}>Remove</button
              >
            </div>
          {/each}
          <div class="btn-row">
            <button type="button" class="btn-secondary" onclick={() => draft?.metadata.push({ key: "", value: "" })}
              >Add metadata row</button
            >
          </div>
        </div>
      </fieldset>
      {#if editing && !editing.inherited}<div class="project-removal">
          {#if !removing}<button
              type="button"
              class="quiet danger-action"
              disabled={busy}
              onclick={() => (removing = true)}>Remove {editing.name}…</button
            >{:else}<p>Remove this project from config.json. Its directories then select no project.</p>
            <div class="btn-row">
              <button type="button" class="btn-secondary" disabled={busy} onclick={() => (removing = false)}
                >Keep project</button
              ><button type="button" class="btn-danger" disabled={busy} onclick={remove}>Confirm removal</button>
            </div>{/if}
        </div>{/if}
    </div>
    <div class="settings-footer">
      {#each errors as message}<p class="field-error" role="alert">{message}</p>{/each}
      <div class="btn-row">
        <button type="button" class="btn-secondary" disabled={busy} onclick={() => (draft = undefined)}>Cancel</button
        ><button type="submit" disabled={busy || errors.length > 0}>{editing ? "Save project" : "Add project"}</button>
      </div>
    </div>
  </form>
{/if}

<style>
  .project-list {
    display: grid;
    gap: var(--space-4);
    margin-block-end: var(--space-4);
  }
  .project-list p {
    margin: 0;
  }
  .card-head h3 {
    flex: 1;
    overflow-wrap: anywhere;
  }
  fieldset.field {
    gap: var(--space-3);
  }
  .scope-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    align-items: center;
    gap: var(--space-2);
  }
  .scope-row :global(.check-label),
  .scope-row button {
    justify-self: start;
  }
  .project-removal {
    display: grid;
    gap: var(--space-3);
    border-block-start: 1px solid var(--border);
    padding-block-start: var(--space-4);
  }
  .danger-action {
    color: var(--fail);
    justify-self: start;
  }
</style>
