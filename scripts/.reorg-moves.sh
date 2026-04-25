#!/bin/sh
set -e
cd "/home/founder3/code/github/itlackey/agentikit"
mkdir -p src/commands
mkdir -p src/core
mkdir -p src/indexer
mkdir -p src/integrations
mkdir -p src/llm
mkdir -p src/llm/embedders
mkdir -p src/output
mkdir -p src/registry
mkdir -p src/registry/registry-providers
mkdir -p src/setup
mkdir -p src/sources
mkdir -p src/sources/source-providers
mkdir -p src/wiki
mkdir -p src/workflows
git mv src/config.ts src/core/config.ts
git mv src/errors.ts src/core/errors.ts
git mv src/paths.ts src/core/paths.ts
git mv src/common.ts src/core/common.ts
git mv src/warn.ts src/core/warn.ts
git mv src/asset-ref.ts src/core/asset-ref.ts
git mv src/asset-spec.ts src/core/asset-spec.ts
git mv src/asset-registry.ts src/core/asset-registry.ts
git mv src/frontmatter.ts src/core/frontmatter.ts
git mv src/markdown.ts src/core/markdown.ts
git mv src/curate.ts src/commands/curate.ts
git mv src/init.ts src/commands/init.ts
git mv src/info.ts src/commands/info.ts
git mv src/remember.ts src/commands/remember.ts
git mv src/completions.ts src/commands/completions.ts
git mv src/self-update.ts src/commands/self-update.ts
git mv src/migration-help.ts src/commands/migration-help.ts
git mv src/vault.ts src/commands/vault.ts
git mv src/source-add.ts src/commands/source-add.ts
git mv src/source-clone.ts src/commands/source-clone.ts
git mv src/source-manage.ts src/commands/source-manage.ts
git mv src/installed-stashes.ts src/commands/installed-stashes.ts
git mv src/install-audit.ts src/commands/install-audit.ts
git mv src/config-cli.ts src/commands/config-cli.ts
git mv src/indexer.ts src/indexer/indexer.ts
git mv src/db.ts src/indexer/db.ts
git mv src/db-search.ts src/indexer/db-search.ts
git mv src/search-fields.ts src/indexer/search-fields.ts
git mv src/search-source.ts src/indexer/search-source.ts
git mv src/usage-events.ts src/indexer/usage-events.ts
git mv src/walker.ts src/indexer/walker.ts
git mv src/metadata.ts src/indexer/metadata.ts
git mv src/file-context.ts src/indexer/file-context.ts
git mv src/matchers.ts src/indexer/matchers.ts
git mv src/manifest.ts src/indexer/manifest.ts
git mv src/semantic-status.ts src/indexer/semantic-status.ts
git mv src/source-provider.ts src/sources/source-provider.ts
git mv src/source-provider-factory.ts src/sources/source-provider-factory.ts
git mv src/source-types.ts src/sources/source-types.ts
git mv src/source-resolve.ts src/sources/source-resolve.ts
git mv src/source-include.ts src/sources/source-include.ts
git mv src/registry-build-index.ts src/registry/registry-build-index.ts
git mv src/registry-factory.ts src/registry/registry-factory.ts
git mv src/registry-resolve.ts src/registry/registry-resolve.ts
git mv src/registry-types.ts src/registry/registry-types.ts
git mv src/origin-resolve.ts src/registry/origin-resolve.ts
git mv src/create-provider-registry.ts src/registry/create-provider-registry.ts
git mv src/llm-client.ts src/llm/llm-client.ts
git mv src/metadata-enhance.ts src/llm/metadata-enhance.ts
git mv src/embedder.ts src/llm/embedder.ts
git mv src/output-shapes.ts src/output/output-shapes.ts
git mv src/output-text.ts src/output/output-text.ts
git mv src/output-context.ts src/output/output-context.ts
git mv src/renderers.ts src/output/renderers.ts
git mv src/cli-hints.ts src/output/cli-hints.ts
git mv src/setup.ts src/setup/setup.ts
git mv src/setup-steps.ts src/setup/setup-steps.ts
git mv src/detect.ts src/setup/detect.ts
git mv src/ripgrep-install.ts src/setup/ripgrep-install.ts
git mv src/ripgrep-resolve.ts src/setup/ripgrep-resolve.ts
git mv src/wiki.ts src/wiki/wiki.ts
git mv src/workflow-authoring.ts src/workflows/workflow-authoring.ts
git mv src/workflow-cli.ts src/workflows/workflow-cli.ts
git mv src/workflow-db.ts src/workflows/workflow-db.ts
git mv src/workflow-markdown.ts src/workflows/workflow-markdown.ts
git mv src/workflow-runs.ts src/workflows/workflow-runs.ts
git mv src/github.ts src/integrations/github.ts
git mv src/lockfile.ts src/integrations/lockfile.ts
git mv src/source-providers/filesystem.ts src/sources/source-providers/filesystem.ts
git mv src/source-providers/tar-utils.ts src/sources/source-providers/tar-utils.ts
git mv src/source-providers/git.ts src/sources/source-providers/git.ts
git mv src/source-providers/sync-from-ref.ts src/sources/source-providers/sync-from-ref.ts
git mv src/source-providers/install-types.ts src/sources/source-providers/install-types.ts
git mv src/source-providers/index.ts src/sources/source-providers/index.ts
git mv src/source-providers/npm.ts src/sources/source-providers/npm.ts
git mv src/source-providers/provider-utils.ts src/sources/source-providers/provider-utils.ts
git mv src/source-providers/website.ts src/sources/source-providers/website.ts
git mv src/registry-providers/skills-sh.ts src/registry/registry-providers/skills-sh.ts
git mv src/registry-providers/static-index.ts src/registry/registry-providers/static-index.ts
git mv src/registry-providers/types.ts src/registry/registry-providers/types.ts
git mv src/registry-providers/index.ts src/registry/registry-providers/index.ts
git mv src/embedders/local.ts src/llm/embedders/local.ts
git mv src/embedders/cache.ts src/llm/embedders/cache.ts
git mv src/embedders/types.ts src/llm/embedders/types.ts
git mv src/embedders/remote.ts src/llm/embedders/remote.ts
