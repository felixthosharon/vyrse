"""Sort a folder's loose files into subfolders by type (Downloads, Desktop, …), after the user says yes.

Nothing is ever deleted or overwritten: a name already taken gets " (2)". Subfolders, half-finished downloads and
system files stay where they are. Every move is written to a manifest first, so `undo` puts it all back.
"""
from __future__ import annotations

import ctypes
import json
import os
import shutil
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

GROUPS: Dict[str, Tuple[str, ...]] = {
    "Images": ("jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif", "tif", "tiff", "ico", "avif", "raw", "psd"),
    "Videos": ("mp4", "mkv", "mov", "avi", "webm", "wmv", "flv", "m4v", "3gp"),
    "Audio": ("mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "mid", "midi"),
    "Documents": ("pdf", "doc", "docx", "txt", "rtf", "odt", "xls", "xlsx", "csv", "ppt", "pptx", "odp", "ods", "md",
                  "epub", "pages", "numbers", "key", "json", "xml"),
    "Installers": ("exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "apk", "dmg", "iso", "img", "bat", "cmd", "ps1", "reg"),
    "Archives": ("zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab"),
    "Code": ("py", "js", "ts", "tsx", "jsx", "html", "css", "c", "cpp", "h", "hpp", "cs", "java", "kt", "go", "rs", "rb",
             "php", "sh", "lua", "sql", "ipynb", "yml", "yaml", "toml", "ini", "cfg"),
    "Fonts": ("ttf", "otf", "woff", "woff2"),
    "3D": ("stl", "obj", "fbx", "blend", "3mf", "gltf", "glb"),
}
_BY_EXT = {ext: name for name, exts in GROUPS.items() for ext in exts}
OTHER = "Other"
# still downloading / temporary / Windows' own
_SKIP_EXT = {"crdownload", "part", "partial", "download", "tmp", "opdownload", "!ut", "aria2"}
_SKIP_NAME = {"desktop.ini", "thumbs.db", ".ds_store"}
_KNOWN = {  # FOLDERID GUIDs, so OneDrive-redirected folders resolve right
    "downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
    "desktop": "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}",
    "documents": "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}",
    "pictures": "{33E28130-4E1E-4676-835A-98395C3BC3BB}",
    "videos": "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}",
    "music": "{4BD8D571-6D19-48D3-BE97-422220080E43}",
}


def _known_folder(name: str) -> Optional[Path]:
    guid = _KNOWN.get(name.strip().lower())
    if not guid:
        return None
    try:
        class GUID(ctypes.Structure):
            _fields_ = [("a", ctypes.c_ulong), ("b", ctypes.c_ushort), ("c", ctypes.c_ushort), ("d", ctypes.c_ubyte * 8)]

        g = GUID()
        ctypes.oledll.ole32.CLSIDFromString(guid, ctypes.byref(g))
        out = ctypes.c_wchar_p()
        ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(out))
        path = Path(out.value)
        ctypes.windll.ole32.CoTaskMemFree(out)
        return path
    except Exception:
        return Path.home() / name.capitalize()


def resolve(where: str) -> Path:
    where = (where or "downloads").strip().strip('"')
    path = _known_folder(where) or Path(os.path.expandvars(os.path.expanduser(where)))
    return path


def _group(path: Path) -> str:
    return _BY_EXT.get(path.suffix.lower().lstrip("."), OTHER)


def _hidden(path: Path) -> bool:
    try:
        attrs = os.stat(path).st_file_attributes  # type: ignore[attr-defined]
        return bool(attrs & 0x2 or attrs & 0x4)  # hidden, system
    except (AttributeError, OSError):
        return path.name.startswith(".")


def plan(folder: Path) -> Dict[str, Any]:
    """What would move where, without touching anything."""
    moves: List[Tuple[Path, str]] = []
    skipped = 0
    size = 0
    for entry in folder.iterdir():
        if not entry.is_file():
            continue
        if entry.name.lower() in _SKIP_NAME or entry.suffix.lower().lstrip(".") in _SKIP_EXT or _hidden(entry):
            skipped += 1
            continue
        moves.append((entry, _group(entry)))
        try:
            size += entry.stat().st_size
        except OSError:
            pass
    counts = Counter(group for _, group in moves)
    return {"moves": moves, "counts": counts, "bytes": size, "skipped": skipped}


def _free_name(target: Path) -> Path:
    if not target.exists():
        return target
    stem, suffix, n = target.stem, target.suffix, 2
    while True:
        candidate = target.with_name(f"{stem} ({n}){suffix}")
        if not candidate.exists():
            return candidate
        n += 1


def _manifest_dir() -> Path:
    home = Path(os.environ.get("HERMES_HOME") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "hermes")
    d = home / "vyrse" / "organize"
    d.mkdir(parents=True, exist_ok=True)
    return d


def apply(folder: Path, moves: List[Tuple[Path, str]]) -> Dict[str, Any]:
    manifest = _manifest_dir() / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.json"
    record: Dict[str, Any] = {"folder": str(folder), "created": [], "moves": [], "at": time.time()}
    done: Counter = Counter()
    failed: List[str] = []
    for src, group in moves:
        dest_dir = folder / group
        if not dest_dir.exists():
            dest_dir.mkdir()
            record["created"].append(str(dest_dir))
        dest = _free_name(dest_dir / src.name)
        try:
            shutil.move(str(src), str(dest))
        except OSError:  # open in another app, or permissions: leave it
            failed.append(src.name)
            continue
        record["moves"].append([str(src), str(dest)])
        done[group] += 1
        # written as it goes, so an interrupted run can still be undone
        if len(record["moves"]) % 50 == 0:
            manifest.write_text(json.dumps(record), encoding="utf-8")
    manifest.write_text(json.dumps(record), encoding="utf-8")
    return {"moved": done, "failed": failed, "manifest": str(manifest)}


def undo(folder: Optional[Path] = None) -> Dict[str, Any]:
    """Put the last sort (of `folder`, if given) back exactly as it was."""
    files = sorted(_manifest_dir().glob("*.json"), reverse=True)
    for mf in files:
        record = json.loads(mf.read_text(encoding="utf-8"))
        if record.get("undone") or (folder and Path(record["folder"]) != folder):
            continue
        back, missing = 0, 0
        for src, dest in reversed(record["moves"]):
            s, d = Path(src), Path(dest)
            if d.exists() and not s.exists():
                shutil.move(str(d), str(s))
                back += 1
            else:
                missing += 1
        for created in record["created"]:
            try:
                Path(created).rmdir()  # only if empty: never removes anything else
            except OSError:
                pass
        record["undone"] = True
        mf.write_text(json.dumps(record), encoding="utf-8")
        return {"ok": True, "folder": record["folder"], "moved_back": back, "not_found": missing}
    return {"ok": False, "error": "There's no sort to undo."}


def card(folder: Path, counts: Counter, total: int, size: int, sorted_: bool) -> Dict[str, Any]:
    """The workspace card: one row per folder with its count."""
    name = folder.name or str(folder)
    return {
        "id": f"organize-{name.lower()}",
        "title": name,
        "kind": "folders",
        "folders": [{"name": g, "count": c} for g, c in counts.most_common()],
        "total": total,
        "size_gb": round(size / 1e9, 1),
        "sorted": sorted_,
        "caption": "Sorted into folders · nothing deleted" if sorted_ else "Not sorted yet",
    }


def organize(where: str, confirmed: bool = False) -> Dict[str, Any]:
    from .. import confirm
    from ..workspace import deliver

    folder = resolve(where)
    if not folder.is_dir():
        return {"ok": False, "error": f"No folder at {folder}."}
    p = plan(folder)
    total = len(p["moves"])
    if not total:
        return {"ok": True, "folder": str(folder), "note": "Nothing loose to sort: every file is already in a folder."}
    counts: Counter = p["counts"]
    summary = ", ".join(f"{c} {g.lower()}" for g, c in counts.most_common(4))
    question = (f"Sort {total:,} files in {folder.name} into {len(counts)} folders ({summary}…)? "
                "Nothing is deleted, and you can undo it.")
    if not confirmed:
        choice = confirm.ask(question, ["Sort them", "Cancel"])
        if choice is None:
            return {"ok": False, "folder": str(folder), "files": total, "would_create": dict(counts),
                    "note": "Couldn't ask in the VYRSE window. Tell the user what you'd do and ask them to confirm out loud; "
                            "then call again with confirmed=true."}
        if choice != "Sort them":
            return {"ok": True, "cancelled": True, "note": "The user said no. Nothing was moved."}
    result = apply(folder, p["moves"])
    moved: Counter = result["moved"]
    deliver({"action": "workspace", "op": "show", "artifact": card(folder, moved, sum(moved.values()), p["bytes"], True)})
    out: Dict[str, Any] = {"ok": True, "folder": str(folder), "moved": sum(moved.values()), "folders": dict(moved),
                           "left_alone": p["skipped"], "deleted": 0,
                           "note_for_reply": "The sorted folders are on screen. Say it in a sentence: how many files, how "
                                             "many folders, nothing deleted (they can say 'undo that')."}
    if result["failed"]:
        out["in_use_not_moved"] = result["failed"][:10]
    return out
