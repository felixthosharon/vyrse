"""Tool calling for every local model, not only the ones VYRSE was set up with.

Some model families ship a chat template that knows nothing about tools. Gemma 3's is one: run as it is, the
model can't call VYRSE's tools, so it writes the call out as text ("create pop quiz") and makes up answers it
should have looked up (a friend's PC, 2026-11-27: Gemma 3 4B invented his hardware). setup.ps1 only gave VYRSE's
tool template to the one Gemma model it knew by name (gemma-3-12b-q4_k_m).

This gives every model in Hermes' models folder whose family needs it a launch override with VYRSE's template,
whatever the file is called (the family is read from the GGUF header), and keeps any other override already set.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# GGUF `general.architecture` -> VYRSE's tool-capable template for it (assets/templates)
TEMPLATES: Dict[str, str] = {"gemma3": "gemma3-tools.jinja"}


def template_dir() -> Path:
    # The plugin folder is a link to <VYRSE>/hermes-plugin/vyrse; the templates sit in <VYRSE>/assets/templates.
    return Path(__file__).resolve().parents[2] / "assets" / "templates"


def architecture(path: Path) -> str:
    try:
        from hermes_cli.local_runtime.gguf import read_gguf_header

        return read_gguf_header(path).architecture
    except Exception:
        name = path.name.lower()
        return "gemma3" if ("gemma-3" in name or "gemma3" in name) else ""


def needed(models_dir: Path, overrides: Dict[str, dict]) -> Dict[str, dict]:
    """The overrides to add: model id -> its override with the template set (other settings kept)."""
    from hermes_cli.local_runtime.gguf import model_id_from_stem

    add: Dict[str, dict] = {}
    for gguf in sorted(models_dir.glob("*.gguf")):
        if gguf.name.lower().startswith("mmproj"):
            continue
        model_id = model_id_from_stem(gguf.stem)
        if model_id in add:
            continue
        template = TEMPLATES.get(architecture(gguf))
        if not template:
            continue
        current = overrides.get(model_id) if isinstance(overrides.get(model_id), dict) else {}
        existing = current.get("chat_template_file")
        if existing and Path(str(existing)).expanduser().is_file():
            continue
        path = template_dir() / template
        if not path.is_file():
            logger.warning("vyrse: tool template missing: %s", path)
            continue
        add[model_id] = {**current, "chat_template_file": str(path).replace("\\", "/")}
    return add


def ensure(models_dir: Optional[Path] = None) -> bool:
    """Add the missing overrides to Hermes' config. True when something changed (the runtime needs a refresh)."""
    try:
        from hermes_cli.config import load_config_readonly, save_config
        from hermes_cli.local_runtime import bootstrap

        folder = models_dir or bootstrap.models_dir()
        if not folder.is_dir():
            return False
        overrides = ((load_config_readonly() or {}).get("local_runtime") or {}).get("launch_overrides") or {}
        add = needed(folder, overrides if isinstance(overrides, dict) else {})
        if not add:
            return False
        save_config({"local_runtime": {"launch_overrides": add}}, merge_existing=True)
        logger.info("vyrse: tool template set for %s", ", ".join(add))
        return True
    except Exception as exc:
        logger.debug("vyrse: model fit check failed: %s", exc)
        return False
