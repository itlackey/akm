import pathlib
import yaml


def test_healthcheck_present():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert "healthcheck" in svc["spec"], "spec.healthcheck block missing"
    hc = svc["spec"]["healthcheck"]
    assert hc.get("path") == "/health", f"expected path=/health, got {hc.get('path')!r}"
    assert hc.get("interval") == 10, f"expected interval=10, got {hc.get('interval')!r}"
    assert hc.get("threshold") == 3, f"expected threshold=3, got {hc.get('threshold')!r}"
