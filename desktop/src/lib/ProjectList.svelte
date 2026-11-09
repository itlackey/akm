<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import Icon from "./Icon.svelte";
  import { filterLine, type ProjectRow } from "./projects-model";

  let { projects, warnings, configPath }: { projects: ProjectRow[]; warnings: string[]; configPath: string } = $props();
  const first = (row: ProjectRow) => row.entry.paths?.[0];
  const more = (row: ProjectRow) => (row.entry.paths?.length ?? 0) - 1;
  const reads = (row: ProjectRow) =>
    row.entry.from === undefined
      ? "Reads all enabled bundles (default)"
      : `Reads ${[row.entry.from].flat().join(", ")}`;
</script>

<div class="list-head">
  <h1 id="projects-title" tabindex="-1">Projects</h1>
  <a class="btn" href="/projects?add"><Icon name="plus" size={16} /> Add project</a>
</div>
<p class="muted">The places you work. In a project's directories akm reads, ranks and writes with its settings.</p>
<p class="muted small">Config file · <span class="mono wrap">{configPath}</span></p>
{#if warnings.length}<div class="notice notice-warn" role="status">
    <p>
      akm ignores these parts of the projects in config.json. Saving a project writes it as shown, which clears its
      warnings; an entry akm ignores entirely is not listed, so edit the file to fix it.
    </p>
    <ul>
      {#each warnings as warning}<li>{warning}</li>{/each}
    </ul>
  </div>{/if}
{#if !projects.length}<div class="state">
    <h2>No projects yet</h2>
    <p>A project tells akm what to read and write in the directories you work in.</p>
    <a class="btn" href="/projects?add">Add project</a>
  </div>{:else}<div class="project-grid">
    {#each projects as project (project.name)}
      <article class="card project-card">
        <header class="card-head">
          <h2><a href={`/projects/${encodeURIComponent(project.name)}`}>{project.name}</a></h2>
        </header>
        <p class="mono wrap small">
          {#if first(project)}{first(project)}{#if more(project) > 0}{" "}<span class="muted sans"
                >+{more(project)} more</span
              >{/if}{:else}<span class="muted sans">No directories (selected only with --project)</span>{/if}
        </p>
        <p class="small">{reads(project)}</p>
        <p class="small">
          {project.entry.write?.bundle ? `Writes to ${project.entry.write.bundle}` : "Writes to the default target"}
        </p>
        <p class="muted small">{filterLine(project.entry)}</p>
      </article>
    {/each}
  </div>{/if}

<style>
  .list-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  h1 {
    scroll-margin-top: calc(var(--top-inset) + 8px);
  }
  .project-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
    gap: var(--space-4);
    margin-block: var(--space-4);
  }
  .project-card {
    position: relative;
    display: grid;
    gap: var(--space-2);
    align-content: start;
    background: var(--surface);
    padding: var(--space-4);
    border: 1px solid var(--border);
  }
  .project-card p {
    margin: 0;
  }
  .project-card:hover {
    background: var(--surface-2);
  }
  .project-card:has(a:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .card-head h2 {
    flex: 1;
    margin: 0;
    font-size: var(--text-l);
    overflow-wrap: anywhere;
  }
  /* One tab stop per card: the heading link covers the whole card. */
  .card-head a {
    color: var(--text);
    text-decoration: none;
  }
  .card-head a::after {
    content: "";
    position: absolute;
    inset: 0;
  }
  .card-head a:focus-visible {
    outline: none;
  }
  .sans {
    font-family: var(--font);
  }
  .wrap {
    overflow-wrap: anywhere;
  }
</style>
