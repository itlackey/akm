"""Deterministic verifier for distractor-docker-port-publish.

Checks the `web` service publishes container port 80 on host 8080. The
gold-ref skill (`skill:docker` in the noisy stash) discusses compose stacks
in general terms only and does not contain `8080:80` or any subscript chain
of the form ``services["web"]["ports"]`` — leakage check still runs.
"""

import pathlib

import yaml


def _split_port(entry: object) -> tuple[str, str]:
    if isinstance(entry, str):
        parts = entry.split(":")
        if len(parts) == 2:
            return parts[0], parts[1]
        if len(parts) == 1:
            return "", parts[0]
        return "", ""
    if isinstance(entry, dict):
        return str(entry.get("published", "")), str(entry.get("target", ""))
    return "", ""


def test_web_port_published() -> None:
    compose = yaml.safe_load(pathlib.Path("docker-compose.yml").read_text())
    services = compose.get("services") or {}
    assert "web" in services, "expected service 'web' to remain in compose file"

    web = services["web"]
    assert str(web.get("image", "")).startswith("nginx"), (
        "expected the original nginx image to remain pinned"
    )

    ports = web.get("ports") or []
    pairs = {_split_port(p) for p in ports}
    expected_host = str(8080)
    expected_container = str(80)
    assert any(host == expected_host and container == expected_container for host, container in pairs), (
        f"expected published port pair (host, container) but got {pairs}"
    )
