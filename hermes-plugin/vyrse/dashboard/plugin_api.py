"""VYRSE plugin backend, mounted at /api/plugins/vyrse/ (session-token authenticated by Hermes)."""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import sys
import time
import wave
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, Body, HTTPException, Request

router = APIRouter()
_PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _load(name: str, relative: str):
    """Load a plugin module by path: this file is imported standalone by the dashboard loader."""
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, _PLUGIN_DIR / relative)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        sys.modules[name] = module
    return sys.modules[name]


def _ui_state():
    return _load("vyrse_plugin_ui_state", "ui_state.py")


@router.get("/health")
async def health() -> Dict[str, Any]:
    return {"ok": True, "plugin": "vyrse"}


@router.get("/model-vision")
async def model_vision(model: str) -> Dict[str, Any]:
    """Can this local model see images? True when a vision projector is configured for it
    (local_runtime.launch_overrides.<model>.mmproj) or the loaded server reports vision; images sent to
    a model without one get invented answers, so VYRSE falls back to text recognition instead."""

    def check() -> bool:
        try:
            from hermes_cli.config import load_config_readonly

            overrides = ((load_config_readonly() or {}).get("local_runtime") or {}).get("launch_overrides") or {}
            entry = overrides.get(model) if isinstance(overrides, dict) else None
            if isinstance(entry, dict) and entry.get("mmproj") and Path(str(entry["mmproj"])).expanduser().is_file():
                return True
        except Exception:
            pass
        try:
            from hermes_cli.local_runtime.capabilities import managed_model_supports_vision

            return bool(managed_model_supports_vision(model))
        except Exception:
            return False

    return {"model": model, "vision": await asyncio.to_thread(check)}


@router.get("/state")
async def get_state() -> Dict[str, Any]:
    styles = _load("vyrse_plugin_styles", "styles.py")
    return {"prefs": {**_ui_state().load(), "customStyles": styles.listing()}}


@router.patch("/state")
async def patch_state(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    prefs, errors = _ui_state().update(body.get("prefs") or {})
    return {"prefs": prefs, "errors": errors}


@router.get("/files/index")
async def files_index_status() -> Dict[str, Any]:
    """The file index (Settings): items and when it last ran."""
    return await asyncio.to_thread(_load("vyrse_plugin_files_index", "files/index.py").status)


@router.post("/files/index")
async def files_index_refresh() -> Dict[str, Any]:
    """Re-index the main folders now (Settings button)."""
    return await asyncio.to_thread(_load("vyrse_plugin_files_index", "files/index.py").refresh)


@router.post("/captions/chunk")
async def captions_chunk(request: Request, to: str = "en", session: str = "") -> Dict[str, Any]:
    """Live captions: one phrase of the PC's audio (16 kHz mono int16) -> the line, translated if needed."""
    captions = _load("vyrse_plugin_captions", "captions.py")
    data = await request.body()
    online = _ui_state().load().get("mode") != "private"
    return await asyncio.to_thread(captions.chunk, data[: 16000 * 2 * 12], to, online, session[:40])


@router.post("/captions/warm")
async def captions_warm() -> Dict[str, Any]:
    """Captions are starting: load the speech model now."""
    return await asyncio.to_thread(_load("vyrse_plugin_captions", "captions.py").warm)


@router.post("/notes/upload")
async def notes_upload(request: Request, title: str = "", ext: str = ".webm") -> Dict[str, Any]:
    """A recording made in VYRSE ("record this lecture"), saved for vyrse_notes to transcribe."""
    notes = _load("vyrse_plugin_notes", "notes.py")
    data = await request.body()
    return await asyncio.to_thread(notes.save_upload, data, title, ext)


@router.get("/reminders/fired")
async def reminders_fired(since: float = 0) -> Dict[str, Any]:
    """Reminder/routine results written after `since` (unix seconds); VYRSE polls this."""
    reminders = _load("vyrse_plugin_reminders", "reminders.py")
    return {"now": time.time(), "fired": await asyncio.to_thread(reminders.fired_since, since)}


def _stop_live(session_id: str, item_id) -> None:
    """Live charts run in the plugin's own module (vyrse_system watch); stop the one being removed."""
    system = sys.modules.get("hermes_plugins.vyrse.system")
    if system is None:
        return
    if item_id:
        system.stop(session_id, item_id)
    else:
        system.stop_all(session_id)


def _workspace():
    return _load("vyrse_plugin_workspace", "workspace.py")


@router.get("/workspace/{session_id}")
async def workspace_items(session_id: str) -> Dict[str, Any]:
    """The conversation's workspace board (what Hermes showed), newest first."""
    return {"items": await asyncio.to_thread(_workspace().load_items, session_id)}


@router.post("/workspace/{session_id}/remove")
async def workspace_remove(session_id: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    item_id = str(body.get("id") or "")
    _stop_live(session_id, item_id)
    await asyncio.to_thread(_workspace().store_remove, session_id, item_id)
    return {"ok": True}


@router.post("/workspace/{session_id}/check")
async def workspace_check(session_id: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """The user ticked (or unticked) a checklist line."""
    index = body.get("index")
    if not isinstance(index, int):
        return {"ok": False}
    await asyncio.to_thread(_workspace().store_check, session_id, str(body.get("id") or ""), index, bool(body.get("done")))
    return {"ok": True}


@router.post("/workspace/{session_id}/update")
async def workspace_update(session_id: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """The user changed an item on the board: timer controls, a card moved on a board, a form sent."""
    art = await asyncio.to_thread(_workspace().store_update, session_id, str(body.get("id") or ""), str(body.get("op") or ""),
                                  body.get("args") if isinstance(body.get("args"), dict) else {})
    return {"ok": art is not None, "artifact": art}


@router.post("/workspace/{session_id}/clear")
async def workspace_clear(session_id: str) -> Dict[str, Any]:
    _stop_live(session_id, None)
    await asyncio.to_thread(_workspace().store_clear, session_id)
    return {"ok": True}


@router.post("/confirm/{qid}")
async def confirm_answer(qid: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Answer to a plugin tool's confirm question (see confirm.py); `choice` null = declined."""
    module = sys.modules.get("hermes_plugins.vyrse.confirm")
    if module is None:
        raise HTTPException(status_code=404, detail="no pending question")
    choice = body.get("choice")
    return {"ok": module.answer(qid, str(choice) if choice is not None else None)}


@router.post("/point/clicked")
async def point_clicked() -> Dict[str, Any]:
    """The user clicked inside the "show me where" ring (the app's overlay saw it): a walkthrough moves on."""
    module = sys.modules.get("hermes_plugins.vyrse.point")
    if module is None:
        raise HTTPException(status_code=503, detail="vyrse plugin not loaded")
    module.ring_clicked.set()
    return {"ok": True}


@router.post("/point/stop")
async def point_stop() -> Dict[str, Any]:
    """Esc while VYRSE has the controls: stop clicking now (the app also interrupts the turn)."""
    module = sys.modules.get("hermes_plugins.vyrse.navigator")
    return {"ok": True, "was_running": bool(module and module.cancel())}


@router.post("/desktop-result/{cid}")
async def desktop_result(cid: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Result of a desktop call a plugin tool is waiting on (see desktop_call.py)."""
    module = sys.modules.get("hermes_plugins.vyrse.desktop_call")
    if module is None:
        raise HTTPException(status_code=404, detail="no pending call")
    return {"ok": module.deliver(cid, body.get("result"))}


def _alexa():
    module = sys.modules.get("hermes_plugins.vyrse.alexa")
    if module is None:
        raise HTTPException(status_code=503, detail="vyrse plugin not loaded")
    return module


@router.get("/voicemonkey")
async def voicemonkey_get() -> Dict[str, Any]:
    """Voice Monkey setup as the UI may see it: configured or not, speaker id, routine names (never the token)."""
    return _alexa().public_voicemonkey()


@router.put("/voicemonkey")
async def voicemonkey_put(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    token = body.get("token")
    routines = body.get("routines")
    return await asyncio.to_thread(
        _alexa().save_voicemonkey,
        str(token) if token is not None else None,
        str(body["speaker"]) if body.get("speaker") is not None else None,
        routines if isinstance(routines, dict) else None,
    )


def _training():
    """The live plugin's wake-word training module (same process, so its job state is shared)."""
    try:
        return importlib.import_module("hermes_plugins.vyrse.wake.training")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"wake training unavailable: {exc}") from exc


@router.get("/wake-train")
async def wake_train_status() -> Dict[str, Any]:
    return _training().status()


@router.post("/wake-train/sample")
async def wake_train_sample(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """One recording for "Teach it my voice": {kind: "wake" | "other", pcm: base64 16 kHz mono int16}."""
    raw = str(body.get("pcm") or "")
    if len(raw) > 16000 * 2 * 11 * 4 // 3 + 16:
        raise HTTPException(status_code=413, detail="recording too long")
    try:
        return {"takes": _training().save_sample(str(body.get("kind") or ""), base64.b64decode(raw, validate=True))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/wake-train/start")
async def wake_train_start() -> Dict[str, Any]:
    try:
        return _training().start()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/wake-train/clear")
async def wake_train_clear() -> Dict[str, Any]:
    try:
        return {"takes": _training().clear()}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _installed_wake_model() -> Path:
    from hermes_constants import get_hermes_home
    from tools.wake_word import load_wake_word_config

    section = load_wake_word_config().get("heed") or {}
    return Path(section.get("model") or Path(get_hermes_home()) / "vyrse" / "models" / "wairz.npz")


@router.get("/wake-model")
async def wake_model() -> Dict[str, Any]:
    """The PC's installed wake-word model as JSON, for the phone app's on-device detector (so the phone
    listens with the same model: the user's own trained one if they made it)."""
    path = _installed_wake_model()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no wake word model installed")

    def convert() -> Dict[str, Any]:
        import json

        import numpy as np

        data = np.load(str(path))
        meta = json.loads(bytes(data["meta"]).decode("utf-8"))
        out: Dict[str, Any] = {"meta": meta, "weights": {}, "sos": [], "zi": []}
        for k in data.files:
            if k.startswith("w."):
                a = data[k].astype(np.float32)
                out["weights"][k[2:]] = {"shape": list(a.shape), "data": [round(float(v), 7) for v in a.ravel()]}
        for i in range(int(meta["n_sos"])):
            out["sos"].append([float(v) for v in data[f"sos.{i}"].ravel()])
            out["zi"].append([float(v) for v in data[f"zi.{i}"].ravel()])
        return out

    return await asyncio.to_thread(convert)


@router.post("/mic-test")
async def mic_test(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Settings → Voice → Test microphone. Scores 16 kHz int16 mono PCM with the wake detector exactly
    as live audio is scored (100 ms steps) and saves it to %HERMES_HOME%/vyrse/debug/ for diagnosis."""
    raw = base64.b64decode(str(body.get("pcm") or ""), validate=False)
    if not raw or len(raw) > 16000 * 2 * 15:
        raise HTTPException(status_code=400, detail="send 0.1-15 s of 16 kHz int16 mono PCM as base64 'pcm'")
    return await asyncio.to_thread(_score_and_save, raw)


def _score_and_save(raw: bytes) -> Dict[str, Any]:
    import numpy as np
    from hermes_constants import get_hermes_home

    pcm = np.frombuffer(raw, dtype="<i2")
    audio = pcm.astype(np.float32) / 32768.0
    debug_dir = Path(get_hermes_home()) / "vyrse" / "debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    # Recordings of the user's voice: only the latest few are kept.
    for old in sorted(debug_dir.glob("mic-test-*.wav"))[:-4]:
        try:
            old.unlink()
        except OSError:
            pass
    path = debug_dir / f"mic-test-{time.strftime('%Y%m%d-%H%M%S')}.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(pcm.tobytes())

    heed = _load("vyrse_plugin_heed_numpy", "wake/heed_numpy.py")
    from tools.wake_word import load_wake_word_config
    section = (load_wake_word_config().get("heed") or {}) if isinstance(load_wake_word_config().get("heed"), dict) else {}
    model = Path(section.get("model") or Path(get_hermes_home()) / "vyrse" / "models" / "wairz.npz")
    detector = heed.HeedDetector(model, threshold=section.get("threshold"))
    probs, gated, triggered = [], 0, False
    for i, start in enumerate(range(0, len(audio) - 1600 + 1, 1600)):
        result = detector.step(audio[start:start + 1600], now=i * 0.1)
        probs.append(float(result["prob"]))
        gated += int(bool(result["gated"]))
        triggered = triggered or bool(result["triggered"])
    peak = float(np.abs(audio).max()) if audio.size else 0.0
    loudest = max((float(np.sqrt(np.mean(audio[s:s + 1600] ** 2))) for s in range(0, max(1, len(audio) - 1600), 1600)), default=0.0)
    db = lambda v: round(20 * float(np.log10(max(v, 1e-9))), 1)  # noqa: E731
    return {
        "saved": str(path),
        "peak_dbfs": db(peak),
        "loudest_rms_dbfs": db(loudest),
        "wake_max_prob": round(max(probs, default=0.0), 3),
        "wake_threshold": detector.threshold,
        "wake_triggered": triggered,
        "gated_fraction": round(gated / max(1, len(probs)), 2),
    }
