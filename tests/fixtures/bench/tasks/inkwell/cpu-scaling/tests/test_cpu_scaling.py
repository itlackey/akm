import pathlib
import yaml


def test_cpu_scaling():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert "scaling" in svc["spec"], "spec.scaling block missing"
    sc = svc["spec"]["scaling"]
    assert sc.get("metric") == "cpu", f"expected metric=cpu, got {sc.get('metric')!r}"
    assert sc.get("target") == 65, f"expected target=65, got {sc.get('target')!r}"
    assert sc.get("min") == 1, f"expected min=1, got {sc.get('min')!r}"
    assert sc.get("max") == 8, f"expected max=8, got {sc.get('max')!r}"
