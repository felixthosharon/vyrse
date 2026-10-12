"""Drop-in local models: any .gguf pasted into the VYRSE models folder shows up in Hermes.

Watches `vyrse.models_dir` (Hermes config; set by scripts/setup.ps1) and mirrors it into Hermes'
managed models dir the same way Hermes' own "Add model file" does (hardlink, no extra disk), then
refreshes the local runtime — only while no model is busy, so a reply is never cut off. Files removed
from the folder are unlinked again (only the ones this watcher linked). Vision projector files
(`mmproj*`) are left to Hermes.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)
_INTERVAL_S = 10.0
_started = False


def _watched_dir() -> Optional[Path]:
    try:
        from hermes_cli.config import load_config_readonly
        value = (load_config_readonly().get("vyrse") or {}).get("models_dir")
    except Exception:
        return None
    return Path(value) if value else None


def _manifest_path() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "vyrse" / "linked_models.json"


def _load_manifest() -> Dict[str, str]:
    try:
        return json.loads(_manifest_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_manifest(manifest: Dict[str, str]) -> None:
    path = _manifest_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")


def _runtime_idle() -> bool:
    """True when the managed llama.cpp server has no request in flight (or isn't running)."""
    try:
        from hermes_cli.local_runtime import bootstrap
        sup = bootstrap.get_supervisor()
        if sup is None:
            return True
        return all(sup.is_idle(model_id) for model_id, state in sup.models().items() if state in ("loaded", "loading"))
    except Exception:
        return False


def sync_once(sizes: Dict[str, int]) -> bool:
    """One scan. Returns True when Hermes' model list changed. `sizes` carries file sizes between scans
    so a model still being copied in is only linked once its size stops changing."""
    source_dir = _watched_dir()
    if source_dir is None or not source_dir.is_dir():
        return False
    from hermes_cli.local_runtime import bootstrap

    target_dir = bootstrap.models_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest = _load_manifest()
    changed = False

    for src in sorted(source_dir.glob("*.gguf")):
        if src.name.lower().startswith("mmproj"):
            continue
        size = src.stat().st_size
        stable = sizes.get(src.name) == size
        sizes[src.name] = size
        dest = target_dir / src.name
        if dest.exists() or not stable:
            continue
        try:
            os.link(src, dest)
        except OSError:
            try:
                os.symlink(src, dest)
            except OSError:
                shutil.copyfile(src, dest)
        manifest[src.name] = str(src)
        changed = True
        logger.info("vyrse: new local model %s added to Hermes", src.stem)

    for name, source in list(manifest.items()):
        if Path(source).exists():
            continue
        dest = target_dir / name
        try:
            dest.unlink(missing_ok=True)
        except OSError as exc:  # loaded right now; retry next scan
            logger.debug("vyrse: model %s still in use: %s", name, exc)
            continue
        manifest.pop(name)
        changed = True
        logger.info("vyrse: local model %s removed from Hermes", Path(name).stem)

    if changed:
        _save_manifest(manifest)
    return changed


def start() -> None:
    """Start the watcher once, only in the backend process VYRSE launches (hermes serve)."""
    global _started
    if _started or not os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN"):
        return
    _started = True

    def _loop() -> None:
        sizes: Dict[str, int] = {}
        pending_refresh = False
        while True:
            try:
                pending_refresh = sync_once(sizes) or pending_refresh
                if pending_refresh and _runtime_idle():
                    from hermes_cli.local_runtime import bootstrap
                    bootstrap.refresh_local_runtime()
                    pending_refresh = False
            except Exception as exc:
                logger.debug("vyrse: models watch tick failed: %s", exc)
            time.sleep(_INTERVAL_S)

    threading.Thread(target=_loop, daemon=True, name="vyrse-models-watch").start()
