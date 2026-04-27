---
description: Run terraform plan and apply with guarded auto-approve
---
# terraform-apply

Run `terraform init -upgrade=false`, then `terraform plan -out=tfplan`, then `terraform apply tfplan`. Refuse to run if `terraform validate` fails or if uncommitted `.tf` changes exist in the working tree.
