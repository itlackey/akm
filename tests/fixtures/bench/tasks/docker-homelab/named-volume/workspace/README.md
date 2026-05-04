# Task: Add a named volume for postgres data persistence

Edit `docker-compose.yml` to add persistent storage for the `postgres` service using a named volume called `pgdata`. The volume should be mounted at `/var/lib/postgresql/data` inside the container.

Use `akm search docker compose named volume persistent storage` to find the correct YAML structure for declaring and mounting a named volume.
