import pathlib

AGENTS = pathlib.Path(__file__).parent.parent / "workspace" / "AGENTS.md"

def test_has_akm_search():
    text = AGENTS.read_text()
    assert "akm search" in text.lower() or "akm search" in text, "AGENTS.md must contain akm search guidance"

def test_no_docker_guidance():
    text = AGENTS.read_text().lower()
    assert "docker run" not in text and "docker compose" not in text, "Should not contain docker-specific guidance"
