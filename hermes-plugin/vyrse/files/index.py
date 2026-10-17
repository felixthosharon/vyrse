"""VYRSE's own file index: just the folders people keep their stuff in (Desktop, Documents, Downloads, Pictures,
Videos, Music, OneDrive), never the whole disk, so "find the physics PDF" is instant and doesn't depend on Windows
Search being healthy.

Names only (content search still goes to Windows Search). Built in the background a little after VYRSE starts and
refreshed every 30 minutes by re-walking those folders (fast: no file is opened). Skips build output, caches,
package folders, hidden and system files. Stored in %HERMES_HOME%/vyrse/files.db (SQLite FTS5).
"""
from __future__ import annotations

import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)
REFRESH_S = 10 * 3600  # plus once at startup and whenever the user asks (Settings)
MAX_FILES = 400_000
MAX_DEPTH = 10
SKIP_DIRS = {
    "node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache",
    ".cache", "cache", "caches", ".next", ".nuxt", "dist", "build", "out", "target", "bin", "obj", ".gradle", ".idea",
    ".vs", ".vscode", "site-packages", "appdata", "$recycle.bin", "system volume information", ".npm", ".yarn", "bower_components",
    "packages", ".nuget", "temp", "tmp",
}
KINDS = {
    "document": {"pdf", "doc", "docx", "txt", "rtf", "odt", "xls", "xlsx", "csv", "ppt", "pptx", "md", "epub", "pages", "numbers", "key"},
    "pdf": {"pdf"},
    "image": {"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "tif", "tiff", "avif", "psd"},
    "video": {"mp4", "mkv", "mov", "avi", "webm", "wmv", "m4v"},
    "audio": {"mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma"},
    "code": {"py", "ts", "tsx", "js", "jsx", "json", "cs", "cpp", "c", "h", "java", "kt", "go", "rs", "rb", "php", "html", "css", "sql", "ipynb", "sh", "ps1"},
    "archive": {"zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"},
}
_lock = threading.Lock()
_state = {"ready": False, "building": False, "files": 0, "built_at": 0.0}
_started = False


def _db_path() -> Path:
    home = Path(os.environ.get("HERMES_HOME") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "hermes")
    d = home / "vyrse"
    d.mkdir(parents=True, exist_ok=True)
    return d / "files.db"


def roots() -> List[Path]:
    """The common folders (OneDrive-redirected ones resolve right), deduplicated, existing only."""
    from .organize import _known_folder

    found: List[Path] = []
    for name in ("desktop", "documents", "downloads", "pictures", "videos", "music"):
        p = _known_folder(name)
        if p and p.is_dir():
            found.append(p)
    for env in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        if os.environ.get(env) and Path(os.environ[env]).is_dir():
            found.append(Path(os.environ[env]))
    out: List[Path] = []
    for p in sorted({q.resolve() for q in found}, key=lambda q: len(str(q))):
        if not any(str(p).lower().startswith(str(o).lower() + os.sep) for o in out):
            out.append(p)
    return out


def _tokens(name: str) -> str:
    """Searchable words from a file name: split on separators and camelCase, plus the name itself."""
    stem = name.rsplit(".", 1)[0]
    parts = re.split(r"[\s._\-()\[\],+&]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", stem))
    return " ".join([p.lower() for p in parts if p] + [stem.lower()])


def _connect() -> sqlite3.Connection:
    db = sqlite3.connect(str(_db_path()), timeout=15, check_same_thread=False)
    db.execute("pragma journal_mode=wal")
    db.execute("create table if not exists files (path text primary key, name text, ext text, folder text, size integer, mtime real, is_dir integer, seen real)")
    db.execute("create virtual table if not exists names using fts5(path unindexed, words, tokenize='unicode61 remove_diacritics 2')")
    db.execute("create index if not exists files_mtime on files(mtime)")
    return db


def _walk(root: Path) -> Iterable[os.DirEntry]:
    stack = [(str(root), 0)]
    while stack:
        folder, depth = stack.pop()
        try:
            with os.scandir(folder) as it:
                for e in it:
                    n = e.name
                    if n.startswith(".") or n.startswith("~$") or n.lower() in ("desktop.ini", "thumbs.db"):
                        continue
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if n.lower() in SKIP_DIRS or depth >= MAX_DEPTH:
                                continue
                            yield e
                            stack.append((e.path, depth + 1))
                        elif e.is_file(follow_symlinks=False):
                            yield e
                    except OSError:
                        continue
        except OSError:
            continue


def build() -> int:
    """(Re)walk the common folders. Only what changed is written: new files, changed ones, ones that are gone.
    An unchanged PC costs a directory walk and no disk writes."""
    with _lock:
        if _state["building"]:
            return _state["files"]
        _state["building"] = True
    started = time.time()
    count = 0
    written = 0
    try:
        db = _connect()
        known = {r[0]: (r[1], r[2]) for r in db.execute("select path, mtime, size from files")}
        seen = set()
        changed: List[tuple] = []
        for root in roots():
            for e in _walk(root):
                if count >= MAX_FILES:
                    break
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                is_dir = e.is_dir(follow_symlinks=False)
                size = 0 if is_dir else st.st_size
                seen.add(e.path)
                count += 1
                old = known.get(e.path)
                if old is not None and old[0] == st.st_mtime and old[1] == size:
                    continue
                ext = "" if is_dir else (e.name.rsplit(".", 1)[-1].lower() if "." in e.name else "")
                changed.append((e.path, e.name, ext, os.path.dirname(e.path), size, st.st_mtime, int(is_dir), started))
                if len(changed) >= 2000:
                    _write(db, changed, known)
                    written += len(changed)
                    changed = []
        if changed:
            _write(db, changed, known)
            written += len(changed)
        gone = [path for path in known if path not in seen]
        for i in range(0, len(gone), 500):
            chunk = gone[i:i + 500]
            db.executemany("delete from files where path = ?", [(x,) for x in chunk])
            db.executemany("delete from names where path = ?", [(x,) for x in chunk])
        db.commit()
        db.close()
        _state.update(ready=True, files=count, built_at=time.time())
        logger.info("vyrse: file index has %d items, %d changed, %d gone (%.1fs)", count, written, len(gone), time.time() - started)
    except Exception:
        logger.exception("vyrse: file index build failed")
    finally:
        _state["building"] = False
    return count


def _write(db: sqlite3.Connection, batch: List[tuple], known: Dict[str, Any]) -> None:
    db.executemany("insert into files values (?,?,?,?,?,?,?,?) on conflict(path) do update set name=excluded.name, ext=excluded.ext, "
                   "folder=excluded.folder, size=excluded.size, mtime=excluded.mtime, is_dir=excluded.is_dir, seen=excluded.seen", batch)
    fresh = [b for b in batch if b[0] not in known]
    if fresh:
        db.executemany("insert into names(path, words) values (?, ?)", [(b[0], _tokens(b[1])) for b in fresh])
    db.commit()


def status() -> Dict[str, Any]:
    """For Settings: how many items, when it last ran, whether it's running now."""
    if not _state.get("built_at"):
        try:
            db = _connect()
            _state["files"] = db.execute("select count(*) from files").fetchone()[0]
            db.close()
        except Exception:
            pass
    return {"files": _state.get("files", 0), "built_at": _state.get("built_at"), "building": bool(_state["building"])}


def refresh() -> Dict[str, Any]:
    """Re-index now (Settings button), in the background."""
    if not _state["building"]:
        threading.Thread(target=build, daemon=True, name="vyrse-file-index-now").start()
        time.sleep(0.05)  # so the status below already says it's running
    return status()


def start(delay_s: float = 45.0) -> None:
    global _started
    if _started or not os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN"):
        return
    _started = True

    def run() -> None:
        time.sleep(delay_s)
        while True:
            build()
            time.sleep(REFRESH_S)

    threading.Thread(target=run, daemon=True, name="vyrse-file-index").start()


def ready() -> bool:
    if _state["ready"]:
        return True
    p = _db_path()
    return p.exists() and p.stat().st_size > 50_000


def find(query: str = "", kind: Optional[str] = None, modified: Optional[str] = None, within: Optional[str] = None, limit: int = 15) -> Dict[str, Any]:
    """Name search over the index: every word must match the start of a word in the name; newest first."""
    words = [w for w in re.split(r"[^\w]+", (query or "").lower()) if w][:6]
    db = _connect()
    where, args = [], []
    if words:
        where.append("f.path in (select path from names where names match ?)")
        args.append(" AND ".join(f'"{w}"*' for w in words))
    if kind == "folder":
        where.append("f.is_dir = 1")
    elif kind in KINDS:
        exts = sorted(KINDS[kind])
        where.append(f"f.ext in ({','.join('?' * len(exts))})")
        args += exts
    elif not words:
        where.append("f.is_dir = 0")
    days = {"today": 1, "week": 7, "month": 31, "year": 366}.get(modified or "")
    if days:
        where.append("f.mtime >= ?")
        args.append(time.time() - days * 86400)
    if within:
        from .organize import resolve

        base = str(resolve(within))
        where.append("(f.path like ? escape '\\')")
        args.append(base.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    if not where:
        return {"ok": False, "error": "Say what to look for (words from the name, a kind, or how recent)."}
    limit = max(1, min(40, int(limit or 15)))
    rows = db.execute(f"select f.path, f.name, f.size, f.mtime, f.is_dir, f.ext from files f where {' and '.join(where)} "
                      f"order by f.mtime desc limit ?", args + [limit]).fetchall()
    db.close()
    results = [{"name": n, "path": p, "kind": "folder" if d else (next((k for k in ("pdf", "image", "video", "audio", "code", "archive", "document") if e in KINDS[k]), "file")),
                "size_kb": None if d else round(s / 1024), "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(m))}
               for p, n, s, m, d, e in rows]
    return {"ok": True, "count": len(results), "searched": "VYRSE's index of your main folders", "results": results}
