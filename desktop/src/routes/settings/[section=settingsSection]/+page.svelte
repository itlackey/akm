<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { page } from "$app/state";
  import Settings from "../../../lib/Settings.svelte";
  import { workspace } from "../../../lib/state/workspace.svelte";
</script>

<Settings bundles={workspace.bundles} route={page.params.section} query={new URLSearchParams(page.url.search)} />
