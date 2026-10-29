# Agent Install Guide

`akm` is a portable capability library agents install and configure without
interactive prompts: install the binary, run `akm setup --yes`, add a source,
build the index, then expose `akm hints` output to the agent so it
knows how to search and load bundle content. Configuration lives in
top-level keys validated against the config schema, and semantic search can
run on local embeddings or a remote endpoint depending on what the host
supports.

For the exact command sequence — install, setup, semantic-search
configuration, adding sources, indexing, verification, and installing agent
guidance into `AGENTS.md` — see the
[headless install recipe](../guides/recipes/headless-install.md).
