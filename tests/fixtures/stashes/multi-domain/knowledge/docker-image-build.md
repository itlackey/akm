---
description: Best practices for writing Dockerfiles
---
# Docker Image Build

Order Dockerfile instructions from least- to most-frequently changing to maximise layer cache reuse. Use multi-stage builds to keep runtime images small. Avoid running as root in the final stage.
