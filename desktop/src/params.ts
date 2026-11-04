import { defineParams } from "@sveltejs/kit/params";

const oneOf = (values: string[]) => (value: string) => (values.includes(value) ? value : undefined);

export const params = defineParams({
  libraryView: oneOf(["search", "asset", "files", "edit", "new", "new-sensitive", "compare"]),
  activityView: oneOf(["overview", "improve", "history"]),
  settingsSection: oneOf(["bundles", "config", "software"]),
});
