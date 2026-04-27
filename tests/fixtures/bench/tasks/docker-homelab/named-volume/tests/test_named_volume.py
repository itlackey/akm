import pathlib

import yaml


def _normalize_volume(entry: object) -> tuple[str, str]:
    if isinstance(entry, str):
        parts = entry.split(":")
        return parts[0], parts[1] if len(parts) > 1 else ""
    if isinstance(entry, dict):
        return str(entry.get("source", "")), str(entry.get("target", ""))
    return "", ""


def test_pgdata_named_volume_mounted() -> None:
    compose = yaml.safe_load(pathlib.Path("docker-compose.yml").read_text())
    top_volumes = compose.get("volumes") or {}
    assert "pgdata" in top_volumes, "expected top-level pgdata volume declaration"

    postgres = compose["services"]["postgres"]
    mounts = postgres.get("volumes") or []
    targets = {_normalize_volume(m) for m in mounts}
    assert any(
        src == "pgdata" and tgt == "/var/lib/postgresql/data"
        for src, tgt in targets
    ), f"expected pgdata mounted at /var/lib/postgresql/data, got {targets}"
