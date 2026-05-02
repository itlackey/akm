import pathlib
import yaml


def test_limits_present():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert "limits" in svc["spec"], "spec.limits block missing"
    lim = svc["spec"]["limits"]
    assert lim.get("rps") == 500, f"expected rps=500, got {lim.get('rps')!r}"
    assert lim.get("burst") == 1000, f"expected burst=1000, got {lim.get('burst')!r}"
