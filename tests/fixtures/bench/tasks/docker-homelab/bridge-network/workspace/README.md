# Task: Attach two services to a custom internal bridge network

Edit `docker-compose.yml` to create a custom bridge network named `internal` and attach both the `api` and `worker` services to it. Services on the same network can reach each other by container name.

Use `akm search docker compose network bridge` to find the correct YAML structure.
