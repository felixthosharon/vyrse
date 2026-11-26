import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin

from vyrse import model_fit  # noqa: E402


def _models(tmp_path: Path, *names: str) -> Path:
    for n in names:
        (tmp_path / n).write_bytes(b"not a real gguf")
    return tmp_path


def test_every_gemma3_gets_the_tool_template(tmp_path, monkeypatch):
    folder = _models(tmp_path, "gemma-3-4b-it-Q4_K_M.gguf", "Qwen3.5-4B-Q4_K_M.gguf", "mmproj-gemma-3-4b-f16.gguf",
                     "my-renamed-model.gguf")
    arch = {"gemma-3-4b-it-Q4_K_M.gguf": "gemma3", "my-renamed-model.gguf": "gemma3", "Qwen3.5-4B-Q4_K_M.gguf": "qwen35"}
    monkeypatch.setattr(model_fit, "architecture", lambda p: arch.get(p.name, ""))
    add = model_fit.needed(folder, {})
    assert set(add) == {"gemma-3-4b-it-Q4_K_M", "my-renamed-model"}
    for override in add.values():
        assert override["chat_template_file"].endswith("assets/templates/gemma3-tools.jinja")
        assert Path(override["chat_template_file"]).is_file()


def test_keeps_other_settings_and_working_templates(tmp_path, monkeypatch):
    folder = _models(tmp_path, "gemma-3-12b-q4_k_m.gguf", "gemma-3-4b-it-Q4_K_M.gguf")
    monkeypatch.setattr(model_fit, "architecture", lambda p: "gemma3")
    template = str(model_fit.template_dir() / "gemma3-tools.jinja")
    overrides = {
        "gemma-3-12b-q4_k_m": {"chat_template_file": template, "mmproj": "x.gguf"},  # already right: left alone
        "gemma-3-4b-it-Q4_K_M": {"ctx": 32768, "chat_template_file": "C:/gone/old.jinja"},  # template missing
    }
    add = model_fit.needed(folder, overrides)
    assert list(add) == ["gemma-3-4b-it-Q4_K_M"]
    assert add["gemma-3-4b-it-Q4_K_M"]["ctx"] == 32768


def test_name_fallback_when_the_header_is_unreadable(tmp_path):
    assert model_fit.architecture(tmp_path / "gemma-3-1b-it.gguf") == "gemma3"
    assert model_fit.architecture(tmp_path / "Qwen3.5-4B.gguf") == ""
