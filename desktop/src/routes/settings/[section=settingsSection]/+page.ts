// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { redirect } from "@sveltejs/kit";

/** Links from before the move: connection groups, Add connection and Projects now live elsewhere. */
export const load = ({ params, url }: { params: { section: string }; url: URL }) => {
  const section = params.section === "config" ? (url.searchParams.get("section") ?? "") : "";
  if (section.startsWith("connection-"))
    redirect(307, `/settings/connections?name=${encodeURIComponent(section.slice("connection-".length))}`);
  if (section === "add-connection") redirect(307, "/settings/connections?add");
  if (section === "projects") redirect(307, "/projects");
};
