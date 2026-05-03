import pathlib
import yaml


def test_healthcheck_present():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert "healthcheck" in svc["spec"], "spec.healthcheck block missing"
    hc = svc["spec"]["healthcheck"]
    assert hc.get("path") == "/readyz", f"expected path=/readyz, got {hc.get('path')!r}"
    assert hc.get("interval") == 15, f"expected interval=15, got {hc.get('interval')!r}"
    assert hc.get("threshold") == 2, f"expected threshold=2, got {hc.get('threshold')!r}"
