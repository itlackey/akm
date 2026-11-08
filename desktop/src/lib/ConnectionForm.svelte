<script lang="ts" module>
  function safe(text: string): Record<string, unknown> {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }
</script>

<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { workspace } from "./state/workspace.svelte";
  import {
    connectionChanges,
    connectionDraft,
    connectionEntry,
    connectionErrors,
    newConnectionDraft,
    type ConnectionDraft,
    type ConnectionEntry,
  } from "./connections-model";

  let {
    name,
    original,
    existing,
    inherited,
    busy,
    failure,
    cancelHref,
    save,
  }: {
    /** The connection being edited; empty when creating. */
    name: string;
    original: ConnectionEntry | null;
    existing: string[];
    inherited: boolean;
    busy: boolean;
    /** What akm said when it refused the save. */
    failure: string;
    cancelHref: string;
    /** Resolves to false when the save failed, so the form is dirty again. */
    save: (name: string, entry: ConnectionEntry) => Promise<boolean> | void;
  } = $props();

  // The form is keyed by the connection, so what it starts from never changes while it is open.
  // svelte-ignore state_referenced_locally
  const creating = !original;
  // svelte-ignore state_referenced_locally
  const base = $state.snapshot(original ? connectionDraft(name, original) : newConnectionDraft());
  let draft = $state<ConnectionDraft>($state.snapshot(base));
  let submitted = $state(false),
    saving = $state(false);
  let form = $state<HTMLFormElement>();

  const errors = $derived(connectionErrors(draft, { existing, creating }));
  const problems = $derived(Object.keys(errors).length);
  const changes = $derived(connectionChanges(draft, base) + (creating && draft.name.trim() ? 1 : 0));
  $effect(() => {
    workspace.guard.dirty = changes > 0 && !saving;
    workspace.guard.what = creating
      ? "This new connection has not been saved."
      : `Your changes to “${name}” have not been saved.`;
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
    if ((await save(creating ? draft.name.trim() : name, connectionEntry(draft, original ?? {}))) === false)
      saving = false;
  }
  const shown = (key: string) => (submitted ? errors[key] : undefined);
</script>

{#snippet err(key: string)}{#if shown(key)}<span class="field-error" id={`err-${key}`}>{shown(key)}</span
    >{/if}{/snippet}

<form class="connection-form" bind:this={form} onsubmit={submit} aria-busy={busy} novalidate>
  {#if inherited}<p class="notice">
      This connection comes from a config this one extends. Saving creates a local copy that overrides it.
    </p>{/if}
  {#if original?.apiKeyFile}<p class="notice">
      This connection still has apiKeyFile, which akm no longer reads. Remove it in Advanced or the config file.
    </p>{/if}
  <div class="settings-fields">
    {#if creating}<label class="field">
        <span class="field-label">Name</span>
        <input
          bind:value={draft.name}
          disabled={busy}
          autocomplete="off"
          spellcheck="false"
          aria-invalid={shown("name") ? "true" : undefined}
          aria-describedby={shown("name") ? "err-name" : undefined}
        />
        <span class="field-hint"
          >Lowercase letters, digits and hyphens. Name it “default” to make it the default connection.</span
        >{@render err("name")}
      </label>{:else}<div class="field">
        <span class="field-label">Name</span><span class="mono">{name}</span>
        <span class="field-hint">A connection keeps its name.</span>
      </div>{/if}
    <label class="field">
      <span class="field-label">Endpoint</span>
      <input
        type="url"
        bind:value={draft.endpoint}
        disabled={busy}
        autocomplete="off"
        spellcheck="false"
        aria-invalid={shown("endpoint") ? "true" : undefined}
        aria-describedby={shown("endpoint") ? "err-endpoint" : undefined}
      />
      <span class="field-hint">The OpenAI-compatible base URL (…/v1) or the chat-completions URL.</span>{@render err(
        "endpoint",
      )}
    </label>
    <label class="field">
      <span class="field-label">API key reference</span>
      <input
        class="mono"
        bind:value={draft.apiKey}
        disabled={busy}
        placeholder="$OPENAI_API_KEY"
        autocomplete="off"
        spellcheck="false"
        aria-invalid={shown("apiKey") ? "true" : undefined}
        aria-describedby={shown("apiKey") ? "err-apiKey" : undefined}
      />
      <span class="field-hint"
        >An environment variable such as $OPENAI_API_KEY. akm refuses literal keys. Leave empty for endpoints without a
        key.</span
      >{@render err("apiKey")}
    </label>
    <fieldset class="field models">
      <legend class="field-label">Models</legend>
      <p class="field-hint">
        Aliases such as fast, balanced and reasoning name the model to use. Add any alias you need.
      </p>
      {#each draft.models as row, index}
        <div class="model-row">
          <label class="field"
            ><span class="field-label">Alias <span class="sr-only">{index + 1}</span></span><input
              bind:value={row.alias}
              disabled={busy}
              autocomplete="off"
              spellcheck="false"
              aria-invalid={shown(`alias-${index}`) ? "true" : undefined}
              aria-describedby={shown(`alias-${index}`) ? `err-alias-${index}` : undefined}
            />{@render err(`alias-${index}`)}</label
          >
          <label class="field"
            ><span class="field-label">Model <span class="sr-only">{index + 1}</span></span><input
              bind:value={row.model}
              disabled={busy}
              autocomplete="off"
              spellcheck="false"
              aria-invalid={shown(`model-${index}`) ? "true" : undefined}
              aria-describedby={shown(`model-${index}`) ? `err-model-${index}` : undefined}
            />{@render err(`model-${index}`)}</label
          >
          <button
            type="button"
            class="btn-secondary"
            disabled={busy}
            aria-label={`Remove model ${index + 1}`}
            onclick={() => draft.models.splice(index, 1)}>Remove</button
          >
          <details class="model-options" open={!!row.options && !!shown(`modelOptions-${index}`)}>
            <summary>Options ({row.options.trim() ? Object.keys(safe(row.options)).length : 0})</summary>
            <label class="field"
              ><span class="field-hint"
                >Sent with requests to this model, overriding the connection's options. A JSON object.</span
              ><textarea
                class="mono"
                rows="4"
                bind:value={row.options}
                disabled={busy}
                spellcheck="false"
                aria-label={`Request options for model ${index + 1}`}
                aria-invalid={shown(`modelOptions-${index}`) ? "true" : undefined}
                aria-describedby={shown(`modelOptions-${index}`) ? `err-modelOptions-${index}` : undefined}
              ></textarea>{@render err(`modelOptions-${index}`)}</label
            >
          </details>
        </div>
      {/each}
      <div class="btn-row">
        <button
          type="button"
          class="btn-secondary"
          disabled={busy}
          onclick={() => draft.models.push({ alias: "", model: "", options: "" })}>Add model</button
        >
      </div>
    </fieldset>
    <div class="numbers">
      <label class="field">
        <span class="field-label">Context length (tokens)</span>
        <input
          inputmode="numeric"
          bind:value={draft.contextLength}
          disabled={busy}
          aria-invalid={shown("contextLength") ? "true" : undefined}
          aria-describedby={shown("contextLength") ? "err-contextLength" : undefined}
        />
        <span class="field-hint">Leave empty if unknown.</span>{@render err("contextLength")}
      </label>
      <div class="field">
        <label class="field-label" for="conn-timeout">Timeout (milliseconds)</label>
        <input
          id="conn-timeout"
          inputmode="numeric"
          bind:value={draft.timeoutMs}
          disabled={busy || draft.noTimeout}
          aria-invalid={shown("timeoutMs") ? "true" : undefined}
          aria-describedby={shown("timeoutMs") ? "err-timeoutMs" : undefined}
        />
        <label class="check-label"
          ><input type="checkbox" bind:checked={draft.noTimeout} disabled={busy} /> No timeout</label
        >
        <span class="field-hint">Empty uses akm's default.</span>{@render err("timeoutMs")}
      </div>
      <label class="field">
        <span class="field-label">Concurrency</span>
        <input
          inputmode="numeric"
          bind:value={draft.concurrency}
          disabled={busy}
          aria-invalid={shown("concurrency") ? "true" : undefined}
          aria-describedby={shown("concurrency") ? "err-concurrency" : undefined}
        />
        <span class="field-hint">Requests at the same time. Empty uses akm's default.</span>{@render err("concurrency")}
      </label>
    </div>
    <label class="field">
      <span class="field-label">Request options</span>
      <textarea
        class="mono"
        rows="4"
        bind:value={draft.options}
        disabled={busy}
        spellcheck="false"
        aria-invalid={shown("options") ? "true" : undefined}
        aria-describedby={shown("options") ? "err-options" : undefined}></textarea>
      <span class="field-hint"
        >Sent with every request to this endpoint, in the endpoint's own spelling, e.g. {'{"temperature": 0}'}. A JSON
        object.</span
      >{@render err("options")}
    </label>
  </div>
  {#if failure}<div class="notice notice-fail" role="alert">
      <strong>The connection was not saved.</strong>
      {failure}
    </div>{/if}
  {#if submitted && problems}<p class="field-error" role="alert">
      Fix {problems}
      {problems === 1 ? "problem" : "problems"} before saving.
    </p>{/if}
  <div class="settings-footer sticky-footer">
    <span class="muted small"
      >{changes ? `${changes} unsaved ${changes === 1 ? "change" : "changes"}` : "No unsaved changes"} · Desktop does not
      test connections. Saving only checks the configuration.</span
    >
    <div class="btn-row">
      <a class="btn btn-secondary" href={cancelHref}>Cancel</a><button
        type="submit"
        disabled={busy || (!creating && !changes)}
        >{#if busy}<span class="spinner" aria-hidden="true"></span> Saving…{:else}{creating
            ? "Add connection"
            : "Save connection"}{/if}</button
      >
    </div>
  </div>
</form>

<style>
  .connection-form {
    max-width: 44rem;
    display: grid;
    gap: var(--space-4);
  }
  .connection-form :global(.settings-fields) {
    padding: 0;
  }
  .sticky-footer .btn-row {
    margin-inline-start: auto;
  }
  .sticky-footer > span {
    flex: 1 1 100%;
  }
  .connection-form {
    margin-block-start: var(--space-5);
  }
  .numbers {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    align-items: start;
  }
  @media (width < 48rem) {
    .numbers {
      grid-template-columns: 1fr;
    }
    .sticky-footer .btn-row {
      width: 100%;
    }
    .sticky-footer .btn-row > :global(*) {
      flex: 1;
      justify-content: center;
    }
  }
  .model-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto;
    gap: var(--space-2);
    align-items: end;
    margin-block-end: var(--space-3);
  }
  .model-options {
    grid-column: 1 / -1;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
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
    .model-row {
      grid-template-columns: 1fr auto;
    }
    .model-row > :first-child,
    .model-row > :nth-child(2) {
      grid-column: 1 / -1;
    }
  }
</style>
