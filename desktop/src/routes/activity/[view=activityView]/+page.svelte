<script lang="ts">
  import { page } from "$app/state";
  import Activity from "../../../lib/Activity.svelte";
</script>

<Activity route={page.params.view} query={new URLSearchParams(page.url.search)} />
