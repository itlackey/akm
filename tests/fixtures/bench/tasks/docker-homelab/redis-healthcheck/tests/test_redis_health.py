import pathlib

import yaml


def test_redis_has_healthcheck() -> None:
    compose = yaml.safe_load(pathlib.Path("docker-compose.yml").read_text())
    redis = compose["services"]["redis"]
    assert "healthcheck" in redis
    assert "test" in redis["healthcheck"]
    assert "redis-cli" in str(redis["healthcheck"]["test"])
