<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { page } from "$app/state";
  import Library from "../../../lib/Library.svelte";
  import LibraryMap from "../../../lib/LibraryMap.svelte";
  import { workspace } from "../../../lib/state/workspace.svelte";
</script>

<div class="library-page">
  {#if page.params.view === "map"}<LibraryMap select={page.url.searchParams.get("select") ?? ""} />{:else}<Library
      route={page.params.view}
      query={new URLSearchParams(page.url.search)}
      bundles={workspace.bundles}
      defaultWriteTarget={workspace.defaultWriteTarget}
      bundleRevision={workspace.bundleRevision}
    />{/if}
</div>
