<script lang="ts">
  import { page } from "$app/state";
  import Library from "../../../lib/Library.svelte";
  import { workspace } from "../../../lib/state/workspace.svelte";
</script>

<div class="library-page">
  <Library
    route={page.params.view}
    query={new URLSearchParams(page.url.search)}
    bundles={workspace.bundles}
    defaultWriteTarget={workspace.defaultWriteTarget}
    bundleRevision={workspace.bundleRevision}
  />
</div>
