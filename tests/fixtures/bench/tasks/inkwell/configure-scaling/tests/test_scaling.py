import pathlib
import yaml


def test_scaling_config():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert "scaling" in svc["spec"], "spec.scaling block missing"
    sc = svc["spec"]["scaling"]
    assert sc.get("min") == 2, f"expected min=2, got {sc.get('min')!r}"
    assert sc.get("max") == 20, f"expected max=20, got {sc.get('max')!r}"
    assert sc.get("metric") == "rps", f"expected metric=rps, got {sc.get('metric')!r}"
    assert sc.get("target") == 100, f"expected target=100, got {sc.get('target')!r}"
