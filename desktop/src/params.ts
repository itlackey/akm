// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineParams } from "@sveltejs/kit/params";

const oneOf = (values: string[]) => (value: string) => (values.includes(value) ? value : undefined);

export const params = defineParams({
  libraryView: oneOf(["search", "asset", "files", "edit", "new", "new-sensitive", "compare"]),
  activityView: oneOf(["overview", "improve", "history"]),
  projectSub: oneOf(["edit", "assets", "asset"]),
  settingsSection: oneOf(["bundles", "connections", "config", "software"]),
});
