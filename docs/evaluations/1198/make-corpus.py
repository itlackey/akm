"""Recreate the independently authored synthetic retrieval set. No private data."""
import json
import os
import sys

root = sys.argv[1]
for bundle in ("target", "other"):
    os.makedirs(f"{root}/library/{bundle}/memories", exist_ok=True)
queries = []


def put(bundle, name, text, fields=None):
    with open(f"{root}/library/{bundle}/memories/{name}.md", "w") as out:
        out.write("---\nname: " + name + "\ntype: memory\n" + "".join(
            f"{key}: {json.dumps(value)}\n" for key, value in (fields or {}).items()
        ) + "---\n\n" + text + "\n")


def case(identifier, query, args, answer):
    queries.append(dict(id=identifier, query=query, kind="direct", searchArgs=args, expected=[answer]))


for n in range(120):
    put("target", f"scoped-{n}", "scopequartz scopequartz scopequartz",
        {"scope": dict(user="bob", agent="bob", run="bob", channel="bob")})
put("target", "scoped-eligible", "scopequartz " + "background explanation " * 60,
    {"scope": dict(user="alice", agent="alice", run="alice", channel="alice")})
for key in ("user", "agent", "run", "channel"):
    case("scope-" + key, "scopequartz", ["--filter", key + "=alice"], "target//memories/scoped-eligible")
for n in range(120):
    put("other", f"source-{n}", "sourcequartz sourcequartz sourcequartz")
put("target", "source-eligible", "sourcequartz " + "context discussion " * 60)
case("source", "sourcequartz", ["--from", "target"], "target//memories/source-eligible")
for category, query, field, flags in (
    ("quality", "qualityquartz", {"quality": "proposed"}, []),
    ("current", "beliefquartz", {"beliefState": "archived"}, ["--belief", "current"]),
    ("historical", "historyquartz", {"beliefState": "asserted"}, ["--belief", "historical"]),
):
    for n in range(120):
        put("target", f"{category}-{n}", f"{query} {query} {query}", field)
    put("target", category + "-eligible", query + " " + "context discussion " * 60,
        {"beliefState": "archived"} if category == "historical" else {})
    case(category, query, flags, "target//memories/" + category + "-eligible")

# All possible results are judged independently from the implementation:
# one exact eligible answer, unrelated controls, and the CLI-excluded notes.
rows = []
for query in queries:
    for bundle in ("target", "other"):
        for filename in sorted(os.listdir(f"{root}/library/{bundle}/memories")):
            name = filename[:-3]
            ref = bundle + "//memories/" + name
            valid = True
            if query["id"].startswith("scope-"):
                valid = name == "scoped-eligible"
            elif query["id"] == "source":
                valid = bundle == "target"
            elif query["id"] == "quality":
                valid = not name.startswith("quality-") or name == "quality-eligible"
            elif query["id"] == "current":
                valid = ((not name.startswith("current-") and name != "historical-eligible")
                         or name == "current-eligible")
            elif query["id"] == "historical":
                valid = ((name.startswith("current-") and name != "current-eligible")
                         or name == "historical-eligible")
            accepted = ref in query["expected"]
            row = dict(id=query["id"], ref=ref, grade=3 if accepted else 0,
                       reason="Exact independently authored eligible answer." if accepted
                       else "Unrelated independently authored note." if valid
                       else "Excluded by the selected existing CLI filter.")
            if not valid:
                row["banned"] = True
            if name.startswith("quality-") and name != "quality-eligible":
                row.update(banned=True, reason="Excluded by proposed-quality selection.")
            rows.append(row)
# --from target makes that bundle the display default: these are verified
# aliases of the same target files, not additional relevant documents.
for row in list(rows):
    if row["id"] == "source" and row["ref"].startswith("target//"):
        alias = dict(row)
        alias["ref"] = row["ref"].removeprefix("target//")
        alias["alias_of"] = row["ref"]
        rows.append(alias)
for name, values in (("queries.jsonl", queries), ("qrels.jsonl", rows)):
    with open(root + "/" + name, "w") as out:
        out.write("".join(json.dumps(row) + "\n" for row in values))
with open(root + "/bundles.json", "w") as out:
    json.dump({"target": "akm", "other": "akm"}, out)
