<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api } from "./client";
  let {
    bundle,
    action,
    disabled = false,
  }: { bundle: string; action: (path: string, body: unknown) => Promise<void>; disabled?: boolean } = $props();
  let open = $state(false),
    name = $state(""),
    busy = $state(false),
    error = $state("");
  let plan = $state<{
    index: { entries: number };
    contentRefs: string[];
    activeWorkflowRuns: Array<{ id: string }>;
    nativeSchedulerRows: string[];
  } | null>(null);
  async function preview() {
    busy = true;
    error = "";
    plan = null;
    try {
      plan = await api("/bundles/rename", {}, { bundle, name: name.trim(), dryRun: true });
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="bundle-rename" aria-label="Rename bundle">
  {#if !open}<button
      class="btn-secondary"
      {disabled}
      onclick={() => {
        open = true;
        name = bundle;
      }}>Rename bundle…</button
    >
  {:else}<form
      onsubmit={(event) => {
        event.preventDefault();
        void preview();
      }}
    >
      <label class="field"
        >New bundle name<input
          bind:value={name}
          oninput={() => (plan = null)}
          disabled={disabled || busy}
          required
          autocomplete="off"
        /></label
      >
      <p class="muted small">Changes AKM’s name and stored references. The folder stays where it is.</p>
      {#if error}<p role="alert" class="notice notice-warn">{error}</p>{/if}
      {#if plan}<div class="rename-preview" aria-label="Rename preview">
          <p><strong>{bundle} → {name.trim()}</strong> · {plan.index.entries} indexed assets</p>
          {#if plan.contentRefs.length}<p>
              These files contain old references; AKM reports them but does not rewrite their contents:
            </p>
            <ul>
              {#each plan.contentRefs as file}<li class="mono wrap small">{file}</li>{/each}
            </ul>{/if}
          {#if plan.activeWorkflowRuns.length}<p>
              {plan.activeWorkflowRuns.length} active workflow runs retain frozen references. Finish or abandon them separately.
            </p>{/if}
          {#if plan.nativeSchedulerRows.length}<p>
              {plan.nativeSchedulerRows.length} installed scheduler bindings will be synchronized.
            </p>{/if}
        </div>{/if}
      <div class="btn-row">
        <button
          type="button"
          class="btn-secondary"
          disabled={disabled || busy}
          onclick={() => {
            open = false;
            plan = null;
            error = "";
          }}>Cancel</button
        >{#if plan}<button
            type="button"
            disabled={disabled || busy}
            onclick={() => action("/bundles/rename", { bundle, name: name.trim() })}>Rename bundle</button
          >{:else}<button disabled={disabled || busy || !name.trim() || name.trim() === bundle}
            >{busy ? "Checking…" : "Preview rename"}</button
          >{/if}
      </div>
    </form>{/if}
</section>

<style>
  .bundle-rename form {
    display: grid;
    gap: 16px;
    max-width: 680px;
  }
  .bundle-rename p {
    margin: 0;
    line-height: 1.6;
  }
  .bundle-rename .btn-row {
    justify-content: flex-end;
    margin: 0;
  }
  .rename-preview {
    padding: 16px 0;
    border-top: 1px solid var(--border);
  }
  .rename-preview p + p {
    margin-top: 12px;
  }
  .rename-preview ul {
    padding-left: 20px;
  }
</style>
