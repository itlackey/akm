# Recipe: Turn a Website into a Searchable Bundle

Crawl a documentation site into markdown knowledge assets you can search and
show like any other source.

```sh
akm bundle add https://docs.example.com --name docs
```

Website sources are crawled and converted to markdown knowledge assets, then
indexed locally — no different from a local directory or a git bundle once
they're in.

Control the crawl scope with `--max-pages` (default 50) and `--max-depth`
(default 3):

```sh
akm bundle add https://www.agentic-patterns.com/ --name agent-patterns --max-pages 100
```

`akm bundle add` indexes the crawl when it finishes, so you can search right
away. `akm bundle update agent-patterns` crawls the site again. Nothing
re-crawls on its own: `akm index` crawls a website bundle only if it has never
been crawled on this host.

```sh
akm search "agent" --type knowledge
```

See [Website Sources](../../reference/website-sources.md) for the fetchers and
crawl options, and [Bundles](../bundles.md) for how website bundles are
refreshed.
