<script lang="ts">
  import { page } from "$app/state";
  import Settings from "../../../lib/Settings.svelte";
  import { workspace } from "../../../lib/state/workspace.svelte";
</script>

<Settings bundles={workspace.bundles} route={page.params.section} query={new URLSearchParams(page.url.search)} />
