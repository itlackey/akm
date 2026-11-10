// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The document title of every page: "<view> · <section> · AKM Desktop". After a navigation the route announcer reads
// the title out, so a view inside a section needs a title of its own for the change to be heard.

const sections: Record<string, string> = {
  "": "Home",
  library: "Library",
  projects: "Projects",
  review: "Review",
  activity: "Activity",
  settings: "Settings",
  setup: "Set up",
};

/** What a title is made from: the path and the query of an address (a URL, or the read-only one Kit hands out). */
type Address = { pathname: string; searchParams: Pick<URLSearchParams, "get" | "getAll" | "has"> };

/** The last part of a ref or a path, as a name: "personal//knowledge/restore-laptop" is "restore laptop". */
const named = (ref: string) => ref.split("/").at(-1)?.replace(/[-_]/g, " ") ?? "";
const fileName = (path: string) => path.split("/").at(-1) ?? "";

/** The name of the view an address shows inside its section; "" where the section is the whole page. */
export function viewTitle(url: Address): string {
  const [section = "", first = "", second = ""] = url.pathname.split("/").slice(1).map(decodeURIComponent);
  const query = url.searchParams;
  const ref = query.get("ref") ?? "";
  if (section === "library") {
    if (query.getAll("compare").length === 2) return "Compare assets";
    if (first === "edit") return `Edit ${ref ? named(ref) : fileName(query.get("file") ?? "")}`.trim();
    if (first === "new") return "New knowledge";
    if (first === "new-sensitive") return query.get("kind") === "secret" ? "New secret" : "New environment file";
    if (first === "files") return ref ? named(ref) : fileName(query.get("file") ?? "") || "Files";
    if (ref) return named(ref);
    return query.get("tab") === "misses" ? "Search gaps" : "Search";
  }
  if (section === "review")
    return first ? "Proposal" : query.get("status") === "recent" ? "Recent decisions" : "Pending";
  if (section === "activity") {
    // The names Activity gives its five views.
    if (first === "improve") return "Improve impact";
    if (first === "history") return "Source history";
    const view = query.get("view") ?? "";
    return view === "runs" ? "Runs" : ["retrieval", "usage", "misses"].includes(view) ? "Usage & retrieval" : "Health";
  }
  if (section === "settings")
    return (
      { bundles: "Bundles & index", connections: "Connections", config: "Configuration", software: "Software" }[
        first
      ] ?? ""
    );
  if (section === "projects") {
    if (!first) return query.has("add") ? "Add a project" : "";
    return second === "edit" ? `Edit ${first}` : second ? `${first} assets` : first;
  }
  return "";
}

/** "<view> · <section> · AKM Desktop", without the view where the section is the whole page. */
export function pageTitle(url: Address): string {
  const section = sections[url.pathname.split("/")[1] ?? ""] ?? "Home";
  return [viewTitle(url), section, "AKM Desktop"].filter(Boolean).join(" · ");
}
