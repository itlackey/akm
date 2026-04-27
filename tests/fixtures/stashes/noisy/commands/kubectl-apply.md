---
description: Apply Kubernetes manifests and wait for rollout
---
# kubectl-apply

Run `kubectl apply -f <path>` then `kubectl rollout status deployment/<name> --timeout=120s`. Roll back with `kubectl rollout undo deployment/<name>` if status fails.
