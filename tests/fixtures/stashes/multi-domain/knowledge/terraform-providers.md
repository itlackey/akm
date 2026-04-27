---
description: Pinning and configuring Terraform providers
---
# Terraform Providers

Declare required providers in `terraform { required_providers { ... } }` with version constraints. `terraform init` downloads the provider; `.terraform.lock.hcl` records the exact version and checksums and must be committed.
