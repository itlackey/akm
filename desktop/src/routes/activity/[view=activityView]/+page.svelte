<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { page } from "$app/state";
  import Activity from "../../../lib/Activity.svelte";
</script>

<Activity route={page.params.view} query={new URLSearchParams(page.url.search)} />
