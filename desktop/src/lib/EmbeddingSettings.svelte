<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api, type ApiError } from "./client";
  import {
    embeddingChange,
    embeddingChanges,
    embeddingDraft,
    embeddingErrors,
    keyStatus,
    reembeds,
    type EmbeddingBlock,
    type EmbeddingDraft,
    type EmbeddingSource,
  } from "./embedding-model";
  import type { SettingsConfig } from "./settings-presenter";

  let { config, saved }: { config: SettingsConfig; saved: () => Promise<void> } = $props();

  const original = $derived(config.config.embedding as EmbeddingBlock | undefined);
  const base = $derived(embeddingDraft(original));
  const hasConnection = $derived(config.defaultConnection !== null);
  let draft = $state<EmbeddingDraft>(embeddingDraft(undefined));
  let busy = $state(false),
    submitted = $state(false),
    failure = $state("");
  // A configuration that has just been loaded is the form's baseline.
  $effect.pre(() => {
    draft = { ...base };
    submitted = false;
  });
  const errors = $derived(embeddingErrors(draft, { hasConnection }));
  const changes = $derived(embeddingChanges(draft, base));
  const sources: Array<[EmbeddingSource, string]> = [
    ["local", "Built-in local embedder"],
    ["connection", "A model served by the default connection"],
    ["endpoint", "A remote endpoint"],
  ];
  const disabled = (source: EmbeddingSource) =>
    (source === "local" && !config.localEmbeddings && base.source !== "local") ||
    (source === "connection" && !hasConnection && base.source !== "connection");

  async function save(event: Event) {
    event.preventDefault();
    submitted = true;
    if (Object.keys(errors).length) return;
    const { set, unset, key } = embeddingChange(draft, base, original, String(config.config.semanticSearchMode ?? ""));
    busy = true;
    failure = "";
    let stored = false;
    try {
      if (Object.keys(set).length || unset.length) await api("/config/set", {}, { set, unset });
      stored = true;
      if (key) await api("/config/embedding-key", {}, key);
      await saved();
    } catch (cause) {
      failure = `${stored ? "The settings were saved, but the key was not stored" : "Nothing was saved"}: ${(cause as ApiError).message}`;
      if (stored) await saved();
    } finally {
      busy = false;
    }
  }
</script>

<form class="card settings-card" onsubmit={save}>
  <div class="settings-fields">
    <div class="field">
      <label class="field-label" for="embedding-source">Embedding model</label>
      <select id="embedding-source" bind:value={draft.source} disabled={busy}>
        {#each sources as [value, label]}<option {value} disabled={disabled(value)}
            >{label}{value === "local" && !config.localEmbeddings ? " (not available on this platform)" : ""}</option
          >{/each}
      </select>
      <p class="field-hint">Saving also turns semantic search on.</p>
    </div>
    {#if draft.source !== "local"}
      {#if draft.source === "endpoint"}<div class="field">
          <label class="field-label" for="embedding-endpoint">Endpoint</label>
          <input
            id="embedding-endpoint"
            type="url"
            bind:value={draft.endpoint}
            disabled={busy}
            autocomplete="off"
            spellcheck="false"
            aria-invalid={submitted && errors.endpoint ? "true" : undefined}
            aria-describedby={submitted && errors.endpoint ? "embedding-endpoint-error" : undefined}
          />
          <p class="field-hint">The OpenAI-compatible base URL (…/v1) of the server that embeds.</p>
          {#if submitted && errors.endpoint}<p class="field-error" id="embedding-endpoint-error">
              {errors.endpoint}
            </p>{/if}
        </div>{/if}
      <div class="field">
        <label class="field-label" for="embedding-model">Model</label>
        <input
          id="embedding-model"
          bind:value={draft.model}
          disabled={busy}
          autocomplete="off"
          spellcheck="false"
          aria-invalid={submitted && errors.model ? "true" : undefined}
          aria-describedby={submitted && errors.model ? "embedding-model-error" : undefined}
        />
        {#if draft.source === "connection"}<p class="field-hint">
            Served at the default connection's endpoint, with its key{config.defaultConnection
              ? ` (${config.defaultConnection})`
              : ""}.
          </p>{/if}
        {#if submitted && errors.model}<p class="field-error" id="embedding-model-error">{errors.model}</p>{/if}
      </div>
      {#if draft.source === "endpoint"}<div class="field">
          <label class="field-label" for="embedding-key">API key</label>
          <input
            id="embedding-key"
            class="mono"
            type="password"
            bind:value={draft.apiKey}
            disabled={busy}
            placeholder="$EMBEDDING_API_KEY or the key"
            autocomplete="off"
            spellcheck="false"
          />
          <p class="field-hint">
            {keyStatus(original, config.embeddingKeyEndpoint, draft, base)} A variable such as $EMBEDDING_API_KEY is read
            when needed; a key is kept in credentials.json, never in config.json. Leave empty to keep it.
          </p>
        </div>{/if}
      <div class="field">
        <label class="field-label" for="embedding-dimension">Dimension</label>
        <input
          id="embedding-dimension"
          inputmode="numeric"
          bind:value={draft.dimension}
          disabled={busy}
          aria-invalid={submitted && errors.dimension ? "true" : undefined}
          aria-describedby={submitted && errors.dimension ? "embedding-dimension-error" : undefined}
        />
        <p class="field-hint">Optional: the vector size, for a model that can return several.</p>
        {#if submitted && errors.dimension}<p class="field-error" id="embedding-dimension-error">
            {errors.dimension}
          </p>{/if}
      </div>
    {/if}
    {#if reembeds(draft, base)}<p class="notice" role="status">
        Vectors already built stop applying with this change. The next <code>akm index</code> embeds each entry again under
        the new model.
      </p>{/if}
  </div>
  {#if failure}<div class="notice notice-fail" role="alert">{failure}</div>{/if}
  <div class="settings-footer">
    <span class="muted small">{changes ? `${changes} unsaved changes` : "No unsaved changes"}</span>
    <div class="btn-row">
      <button class="btn-secondary" type="button" disabled={busy || !changes} onclick={() => (draft = { ...base })}
        >Reset changes</button
      ><button disabled={busy || !changes}>Save embeddings</button>
    </div>
  </div>
</form>
