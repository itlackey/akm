import pathlib

import yaml


# Keys that v2 supported at the service level but were removed/replaced in v3.
V2_ONLY_SERVICE_KEYS = {"mem_limit", "cpu_shares", "volume_driver", "cpuset", "cpu_quota"}


def test_compose_upgraded_to_v3_8() -> None:
    raw = pathlib.Path("docker-compose.yml").read_text()
    compose = yaml.safe_load(raw)
    assert str(compose.get("version")) == "3.8", f"expected version 3.8, got {compose.get('version')!r}"

    for name, svc in (compose.get("services") or {}).items():
        leaked = V2_ONLY_SERVICE_KEYS & set(svc or {})
        assert not leaked, f"service {name!r} still has v2-only keys: {leaked}"
