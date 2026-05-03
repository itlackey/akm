import yaml, pathlib, pytest

SERVICE = pathlib.Path(__file__).parent.parent / "workspace" / "service.yaml"

def test_scaling_config():
    doc = yaml.safe_load(SERVICE.read_text())
    spec = doc["spec"]
    scaling = spec.get("scaling", {})
    assert scaling.get("min") == 2, f"expected min=2, got {scaling.get('min')}"
    assert scaling.get("max") == 20, f"expected max=20, got {scaling.get('max')}"
    assert scaling.get("metric") == "rps", f"expected metric=rps, got {scaling.get('metric')}"
    assert scaling.get("target") == 100, f"expected target=100, got {scaling.get('target')}"
