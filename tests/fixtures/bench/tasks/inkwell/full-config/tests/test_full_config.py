import yaml, pathlib

SERVICE = pathlib.Path(__file__).parent.parent / "workspace" / "service.yaml"

def test_full_config():
    doc = yaml.safe_load(SERVICE.read_text())
    spec = doc["spec"]
    s = spec.get("scaling", {})
    assert s.get("min") == 2, f"expected scaling.min=2, got {s.get('min')}"
    assert s.get("max") == 10, f"expected scaling.max=10, got {s.get('max')}"
    assert s.get("metric") == "rps", f"expected metric=rps, got {s.get('metric')}"
    assert s.get("target") == 150, f"expected target=150, got {s.get('target')}"
    h = spec.get("healthcheck", {})
    assert h.get("path") == "/health", f"expected path=/health, got {h.get('path')}"
    assert h.get("interval") == 15, f"expected interval=15, got {h.get('interval')}"
    assert h.get("threshold") == 3, f"expected threshold=3, got {h.get('threshold')}"
    l = spec.get("limits", {})
    assert l.get("rps") == 200, f"expected limits.rps=200, got {l.get('rps')}"
    assert l.get("burst") == 400, f"expected limits.burst=400, got {l.get('burst')}"
