import pathlib

import yaml


def _service_networks(svc: dict) -> set[str]:
    raw = svc.get("networks") or []
    if isinstance(raw, dict):
        return set(raw.keys())
    return {str(n) for n in raw}


def test_internal_bridge_attaches_two_services() -> None:
    compose = yaml.safe_load(pathlib.Path("docker-compose.yml").read_text())
    networks = compose.get("networks") or {}
    assert "internal" in networks, "expected top-level internal network"
    cfg = networks["internal"] or {}
    if isinstance(cfg, dict):
        driver = cfg.get("driver", "bridge")
        assert driver == "bridge", f"expected bridge driver, got {driver}"

    attached = [
        name
        for name, svc in (compose.get("services") or {}).items()
        if "internal" in _service_networks(svc)
    ]
    assert len(attached) >= 2, f"expected 2+ services on internal, got {attached}"
