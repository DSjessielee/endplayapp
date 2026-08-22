import importlib.util
from pathlib import Path


def _load_module(module_name: str, relative_path: str):
    path = Path(__file__).resolve().parents[1] / relative_path
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_anthropic_default_models_are_supported():
    script = _load_module("image_to_pbn_script", "scripts/image_to_pbn.py")
    webapp = _load_module("webapp_module", "webapp/app.py")

    assert script.get_anthropic_model() == "claude-3-5-haiku-latest"
    assert webapp.get_anthropic_model() == "claude-3-5-haiku-latest"
    assert webapp.get_single_hand_model() == "claude-3-5-sonnet-latest"
