import pathlib
import yaml


def test_service_definition():
    svc = yaml.safe_load(pathlib.Path("service.yaml").read_text())
    assert svc.get("apiVersion") == "inkwell/v2", f"expected apiVersion=inkwell/v2, got {svc.get('apiVersion')!r}"
    assert svc.get("kind") == "Service", f"expected kind=Service, got {svc.get('kind')!r}"
    assert svc.get("metadata", {}).get("name") == "api-gateway", "expected metadata.name=api-gateway"
    rt = svc.get("spec", {}).get("runtime", {})
    assert rt.get("image") == "gateway:v2", f"expected image=gateway:v2, got {rt.get('image')!r}"
    assert rt.get("port") == 8080, f"expected port=8080, got {rt.get('port')!r}"
