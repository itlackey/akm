---
description: Role-based access control concepts and az CLI commands for Azure
---
# Azure RBAC

Azure RBAC pairs a security principal with a role definition at a scope. Use `az role assignment create --assignee <id> --role <role> --scope <scope>`. Scope as narrowly as the workload allows; subscription-level Contributor is almost always too broad.
