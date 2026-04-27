import pathlib

import yaml


def test_web_has_restart_policy() -> None:
    compose = yaml.safe_load(pathlib.Path("docker-compose.yml").read_text())
    web = compose["services"]["web"]
    assert web.get("restart") == "unless-stopped"
