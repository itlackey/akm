#!/bin/bash
# Clean up unused Docker images, containers, and volumes
# Removes dangling images, stopped containers, and unused volumes

echo "Cleaning up Docker resources..."
docker container prune -f
docker image prune -af
docker volume prune -f
docker network prune -f
echo "Docker cleanup complete"
