# Docker Image Management

## Building Images

```bash
docker build -t myapp:latest .
```

## Tagging and Pushing

```bash
docker tag myapp:latest registry.example.com/myapp:v1.0
docker push registry.example.com/myapp:v1.0
```

## Listing and Cleaning

```bash
docker images
docker image prune -a
```
