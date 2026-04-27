---
description: Authoring Kubernetes Deployment manifests
---
# Kubernetes Deployments

A Deployment manages a ReplicaSet of Pods. Set explicit `resources.requests`/`limits` and `readinessProbe`. Use `kubectl rollout status deployment/<name>` to wait for a deploy to complete and `kubectl rollout undo` to revert.
