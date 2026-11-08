<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { workspace } from "./state/workspace.svelte";
  import {
    draftChanges,
    draftErrors,
    nameError,
    projectChange,
    projectDraft,
    type ProjectDraft,
    type ProjectRow,
  } from "./projects-model";

  let {
    original,
    bundles,
    existing,
    defaultTarget,
    busy,
    failure,
    cancelHref,
    save,
    remove,
  }: {
    /** The project being edited; null when adding. */
    original: ProjectRow | null;
    bundles: Array<{ name: string; enabled: boolean; writable: boolean }>;
    /** Names of every project, for the duplicate check. */
    existing: string[];
    /** The write bundle used when the project names none, for the select's first option. */
    defaultTarget: string;
    busy: boolean;
    /** What akm said when it refused the save or the removal. */
    failure: string;
    cancelHref: string;
    /** Resolves to false when the save failed, so the form is dirty again. */
    save: (body: ReturnType<typeof projectChange>, name: string) => Promise<boolean> | void;
    remove: () => Promise<boolean> | void;
  } = $props();

  // The form is keyed by the project, so what it starts from never changes while it is open.
  // svelte-ignore state_referenced_locally
  const base = $state.snapshot(projectDraft(original?.name ?? "", original?.entry));
  // svelte-ignore state_referenced_locally
  const inherited = !!original?.inherited;
  let draft = $state<ProjectDraft>($state.snapshot(base));
  let submitted = $state(false),
    removing = $state(false),
    saving = $state(false),
    form = $state<HTMLFormElement>();

  // A configured bundle the project names that is no longer registered stays selectable, so saving does not drop it.
  const known = $derived(bundles.map((b) => b.name));
  const choices = $derived([...new Set([...known, ...base.from, ...draft.from])]);
  const note = (name: string) => {
    const bundle = bundles.find((b) => b.name === name);
    return !bundle ? " (not registered)" : !bundle.enabled ? " (disabled)" : !bundle.writable ? " (read-only)" : "";
  };
  const unusableForWrites = (name: string) => {
    const bundle = bundles.find((b) => b.name === name);
    return !!bundle && (!bundle.enabled || !bundle.writable);
  };
  const pathsProblem = $derived(
    draft.paths
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line && !/^(~([\\/]|$)|\/|[A-Za-z]:[\\/])/.test(line))
      ? "Use an absolute path or one starting with ~."
      : "",
  );
  const listErrors = $derived(draftErrors(draft));
  const nameProblem = $derived(inherited ? "" : nameError(draft.name, existing, original?.name ?? ""));
  const problems = $derived(listErrors.length + (nameProblem ? 1 : 0) + (pathsProblem ? 1 : 0));
  const changes = $derived(draftChanges(draft, base));
  $effect(() => {
    workspace.guard.dirty = changes > 0 && !saving;
    workspace.guard.what = original
      ? `Your changes to “${original.name}” have not been saved.`
      : "This new project has not been saved.";
  });
  onDestroy(() => {
    workspace.guard.dirty = false;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    submitted = true;
    if (problems) {
      await tick();
      form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    saving = true;
    if ((await save(projectChange(draft, original), draft.name.trim())) === false) saving = false;
  }
  async function askRemove() {
    removing = true;
    await tick();
    form?.querySelector<HTMLElement>("[data-keep]")?.focus();
  }
  async function keep() {
    removing = false;
    await tick();
    form?.querySelector<HTMLElement>("[data-remove]")?.focus();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape" && removing && !busy) {
      event.preventDefault();
      void keep();
    }
  }
  function toggle(bundle: string, on: boolean) {
    draft.from = on ? [...draft.from, bundle] : draft.from.filter((name) => name !== bundle);
  }
</script>

{#snippet scope(rows: ProjectDraft["filters"], label: string, hint: string, add: string)}
  <fieldset class="field">
    <legend class="field-label">{label}</legend>
    <p class="field-hint">{hint}</p>
    {#each rows as row, index}
      <div class="scope-row">
        <input
          bind:value={row.key}
          disabled={busy}
          placeholder="Key, such as channel"
          aria-label={`${label} key ${index + 1}`}
        />
        <textarea
          bind:value={row.values}
          rows="2"
          disabled={busy}
          placeholder="One value per line"
          aria-label={`${label} values ${index + 1}`}></textarea>
        <div class="row-foot">
          <label class="inline-check"
            ><input type="checkbox" bind:checked={row.absent} disabled={busy} /> Also when the key is absent</label
          >
          <button
            type="button"
            class="btn-quiet"
            disabled={busy}
            aria-label={`Remove ${label.toLowerCase()} row ${index + 1}`}
            onclick={() => rows.splice(index, 1)}>Remove</button
          >
        </div>
      </div>
    {/each}
    <div class="btn-row">
      <button
        type="button"
        class="btn-secondary"
        disabled={busy}
        onclick={() => rows.push({ key: "", values: "", absent: false })}>{add}</button
      >
    </div>
  </fieldset>
{/snippet}

<!-- Esc cancels the inline removal confirmation; the form's own controls are the interactive elements. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form class="project-form" bind:this={form} onsubmit={submit} onkeydown={keydown} aria-busy={busy} novalidate>
  {#if inherited}<p class="notice">
      This project comes from a config this one extends. Saving creates a local copy with the same name that overrides
      it.
    </p>{/if}
  <div class="settings-fields">
    <label class="field">
      <span class="field-label">Name</span>
      <input
        bind:value={draft.name}
        disabled={busy || inherited}
        autocomplete="off"
        spellcheck="false"
        aria-invalid={submitted && nameProblem ? "true" : undefined}
        aria-describedby={submitted && nameProblem ? "project-name-error" : undefined}
      />
      <span class="field-hint"
        >{inherited
          ? "An inherited project keeps its name."
          : original
            ? "Renaming moves its settings to the new name."
            : "Used with --project and shown in Desktop."}</span
      >
      {#if submitted && nameProblem}<span class="field-error" id="project-name-error">{nameProblem}</span>{/if}
    </label>
    <label class="field">
      <span class="field-label">Directories</span>
      <textarea
        bind:value={draft.paths}
        rows="3"
        disabled={busy}
        placeholder={"~/code/my-project\n/work/my-project"}
        aria-invalid={submitted && pathsProblem ? "true" : undefined}
        spellcheck="false"></textarea>
      <span class="field-hint">One per line, absolute or starting with ~. The most specific match wins.</span>
      {#if submitted && pathsProblem}<span class="field-error">{pathsProblem}</span>{/if}
    </label>
    <h2 class="group">Reads</h2>
    <fieldset class="field">
      <legend class="field-label">Bundles to read</legend>
      <p class="field-hint">None selected reads all enabled bundles.</p>
      {#each choices as bundle (bundle)}
        <label class="check-label"
          ><input
            type="checkbox"
            checked={draft.from.includes(bundle)}
            disabled={busy}
            onchange={(event) => toggle(bundle, event.currentTarget.checked)}
          />
          {bundle}{#if note(bundle)}<span class="muted">{note(bundle)}</span>{/if}</label
        >
      {/each}
    </fieldset>
    {@render scope(
      draft.filters,
      "Filters",
      "Only assets with one of the values are read. A row without values is left out.",
      "Add filter",
    )}
    {@render scope(
      draft.prefer,
      "Prefer",
      `Assets with one of the values rank first. Without any, assets marked project=${draft.name.trim() || "<name>"} do.`,
      "Add preference",
    )}
    <h2 class="group">Writes</h2>
    <label class="field">
      <span class="field-label">Bundle</span>
      <select bind:value={draft.bundle} disabled={busy}>
        <option value="">Default write target{defaultTarget ? ` (${defaultTarget})` : ""}</option>
        {#each choices as bundle}<option value={bundle} disabled={unusableForWrites(bundle) && bundle !== draft.bundle}
            >{bundle}{note(bundle)}</option
          >{/each}
      </select>
      <span class="field-hint">Applied to new memories and proposals made in these directories.</span>
    </label>
    <div class="settings-grid">
      <label class="field"><span class="field-label">User</span><input bind:value={draft.user} disabled={busy} /></label
      >
      <label class="field"
        ><span class="field-label">Agent</span><input bind:value={draft.agent} disabled={busy} /></label
      >
      <label class="field"
        ><span class="field-label">Channel</span><input bind:value={draft.channel} disabled={busy} /></label
      >
    </div>
    <div class="field">
      <span class="field-label">Metadata</span>
      <span class="field-hint">Frontmatter keys added to what is written. Empty keys are left out.</span>
      {#each draft.metadata as row, index}
        <div class="scope-row meta">
          <input bind:value={row.key} disabled={busy} placeholder="Key" aria-label={`Metadata key ${index + 1}`} />
          <input
            bind:value={row.value}
            disabled={busy}
            placeholder="Value"
            aria-label={`Metadata value ${index + 1}`}
          />
          <button
            type="button"
            class="btn-secondary"
            disabled={busy}
            aria-label={`Remove metadata row ${index + 1}`}
            onclick={() => draft.metadata.splice(index, 1)}>Remove</button
          >
        </div>
      {/each}
      <div class="btn-row">
        <button
          type="button"
          class="btn-secondary"
          disabled={busy}
          onclick={() => draft.metadata.push({ key: "", value: "" })}>Add metadata</button
        >
      </div>
    </div>
    {#if original}<div class="project-removal">
        <h2 class="group">Remove</h2>
        {#if inherited}<p class="muted small">To remove it, edit the config that defines it.</p>
        {:else if !removing}<button
            type="button"
            class="btn-quiet danger-action"
            data-remove
            disabled={busy}
            onclick={askRemove}>Remove {original.name}…</button
          >{:else}<p>
            Removes “{original.name}” from this computer's config.json. Its bundles and assets are not changed. If a
            config this one extends also defines “{original.name}”, that definition applies again.
          </p>
          <div class="btn-row">
            <button type="button" class="btn-secondary" data-keep disabled={busy} onclick={keep}>Keep project</button
            ><button
              type="button"
              class="btn-danger"
              disabled={busy}
              onclick={async () => {
                saving = true;
                if ((await remove()) === false) saving = false;
              }}
              >{#if busy}<span class="spinner" aria-hidden="true"></span> Removing…{:else}Remove project{/if}</button
            >
          </div>{/if}
      </div>{/if}
  </div>
  {#if failure}<div class="notice notice-fail" role="alert">
      <strong>The project was not saved.</strong>
      {failure}
    </div>{/if}
  {#each submitted ? listErrors : [] as message}<p class="field-error" role="alert">{message}</p>{/each}
  {#if submitted && problems}<p class="field-error" role="alert">
      Fix {problems}
      {problems === 1 ? "problem" : "problems"} before saving.
    </p>{/if}
  <div class="settings-footer sticky-footer">
    <span class="muted small"
      >{changes ? `${changes} unsaved ${changes === 1 ? "change" : "changes"}` : "No unsaved changes"}</span
    >
    <div class="btn-row">
      <a class="btn btn-secondary" href={cancelHref}>Cancel</a><button
        type="submit"
        disabled={busy || (!!original && !changes)}
        >{#if busy && !removing}<span class="spinner" aria-hidden="true"></span> Saving…{:else}{original
            ? "Save project"
            : "Add project"}{/if}</button
      >
    </div>
  </div>
</form>

<style>
  .project-form {
    margin-block-start: var(--space-5);
    max-width: 44rem;
    display: grid;
    gap: var(--space-4);
  }
  .project-form :global(.settings-fields) {
    padding: 0;
  }
  /* A plain section heading with a rule above it, not a box. */
  .group {
    margin: var(--space-6) 0 0;
    padding: var(--space-4) 0 0;
    border: 0;
    border-block-start: 1px solid var(--border);
    border-radius: 0;
    background: none;
    box-shadow: none;
    font-size: var(--text-l);
    font-weight: 600;
  }
  fieldset.field {
    gap: var(--space-3);
  }
  .scope-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    align-items: start;
    gap: var(--space-2);
    margin-block-end: var(--space-2);
  }
  .scope-row.meta {
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto;
    align-items: center;
  }
  .row-foot {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .inline-check {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-s);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  .project-removal {
    display: grid;
    gap: var(--space-3);
  }
  .danger-action {
    color: var(--fail);
    justify-self: start;
    padding-inline: 0;
  }
  .sticky-footer {
    position: sticky;
    bottom: 0;
    background: var(--bg);
    padding-block: var(--space-3);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  @media (max-width: 600px) {
    .scope-row,
    .scope-row.meta {
      grid-template-columns: 1fr;
    }
  }
  @media (width < 48rem) {
    .sticky-footer .btn-row {
      width: 100%;
    }
    .sticky-footer .btn-row > :global(*) {
      flex: 1;
      justify-content: center;
    }
  }
</style>
