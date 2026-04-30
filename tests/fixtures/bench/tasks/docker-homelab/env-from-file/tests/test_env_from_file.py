import pathlib

import yaml


def test_app_loads_env_from_file() -> None:
    compose = yaml.safe_load(pathlib.Path("docker-compose.yml").read_text())
    app = compose["services"]["app"]
    env_file = app.get("env_file")
    assert env_file is not None, "expected env_file on the app service"
    if isinstance(env_file, str):
        candidates = [env_file]
    else:
        candidates = [
            entry if isinstance(entry, str) else (entry or {}).get("path", "")
            for entry in env_file
        ]
    assert any("app.env" in str(c) for c in candidates)
