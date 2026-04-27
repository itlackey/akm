---
description: Kubernetes Service types and when to use each
---
# Kubernetes Services

`ClusterIP` is the default and exposes a service inside the cluster. `NodePort` opens a static port on every node. `LoadBalancer` provisions a cloud LB. Inside the cluster, prefer `ClusterIP` plus an Ingress rather than `LoadBalancer` per service.
