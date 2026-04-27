---
description: First-line debugging for Kubernetes pod issues
---
# Kubernetes Troubleshooting

`kubectl get pods -A` for cluster-wide state. `kubectl describe pod <name>` shows events including image-pull failures, OOM kills, and probe failures. `kubectl logs <pod> -c <container> --previous` retrieves logs from the last crash.
