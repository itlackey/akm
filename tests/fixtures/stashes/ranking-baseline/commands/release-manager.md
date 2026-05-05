---
description: Manage release process including versioning, changelog, and deployment
tags:
  - release
  - deploy
searchHints:
  - create a release
  - bump version
  - deploy release
quality: curated
---
# Release Manager

Create and deploy a new release version $1.

## Steps

1. Update version in package.json to $1
2. Generate changelog from git history
3. Create git tag v$1
4. Build and publish artifacts
5. Deploy to staging environment
