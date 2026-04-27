---
description: Storing and locking Terraform state safely
---
# Terraform State

Use a remote backend (S3 + DynamoDB lock, Azure Storage with native locking, or Terraform Cloud) for any non-trivial project. Never commit `.tfstate` to git; it contains secrets. Always run `terraform plan` before `apply`.
