#!/bin/bash
# @description Clean up unused Docker images, containers, and volumes
# @tags docker, cleanup
# @searchHints clean docker resources; remove unused images
# Removes dangling images, stopped containers, and unused volumes

echo "Cleaning up Docker resources..."
docker container prune -f
docker image prune -af
docker volume prune -f
docker network prune -f
echo "Docker cleanup complete"
