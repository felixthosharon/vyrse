"""What answering on this PC saved, for "how much have you saved me?".

The same numbers as Settings -> Usage and savings (app/src/services/hermes/extras.ts summarizeUsage): the tokens
each model used in the window, from Hermes' session records; local models count as saved at a typical paid API's
list price, online ones count what they charged. Keep REFERENCE_PRICE and LOCAL_PROVIDERS in step with extras.ts.
"""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List

REFERENCE_PRICE = {"in_per_million": 3.0, "out_per_million": 15.0}
LOCAL_PROVIDERS = {"", "custom", "llamacpp", "local", "ollama", "lmstudio"}


def would_have_cost(input_tokens: float, output_tokens: float) -> float:
    return (input_tokens * REFERENCE_PRICE["in_per_million"] + output_tokens * REFERENCE_PRICE["out_per_million"]) / 1_000_000


def _db_path() -> Path:
    home = Path(os.environ.get("HERMES_HOME") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "hermes")
    return home / "state.db"


def _rows(db_path: Path, cutoff: float) -> List[Dict[str, Any]]:
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in db.execute(
            """select model, coalesce(billing_provider, '') as provider,
                      coalesce(sum(input_tokens), 0) + coalesce(sum(cache_read_tokens), 0) as input,
                      coalesce(sum(output_tokens), 0) as output,
                      coalesce(sum(estimated_cost_usd), 0) as estimated, coalesce(sum(actual_cost_usd), 0) as actual,
                      sum(coalesce(api_call_count, 0)) as calls
               from sessions where started_at > ? and model is not null and model != ''
               group by model, billing_provider""", (cutoff,))]
        try:  # side jobs (vision, compression) are recorded per task, never in the session counters
            rows += [dict(r) for r in db.execute(
                """select u.model, coalesce(u.billing_provider, '') as provider,
                          coalesce(sum(u.input_tokens), 0) + coalesce(sum(u.cache_read_tokens), 0) as input,
                          coalesce(sum(u.output_tokens), 0) as output,
                          coalesce(sum(u.estimated_cost_usd), 0) as estimated, 0 as actual,
                          sum(coalesce(u.api_call_count, 0)) as calls
                   from session_model_usage u join sessions s on s.id = u.session_id
                   where s.started_at > ? and u.task != ''
                   group by u.model, u.billing_provider""", (cutoff,))]
        except sqlite3.Error:
            pass
        return rows
    finally:
        db.close()


def summary(days: int = 30, db_path: Path | None = None, now: float | None = None) -> Dict[str, Any]:
    days = max(1, min(365, int(days)))
    path = db_path or _db_path()
    if not path.is_file():
        return {"ok": False, "error": "No usage recorded yet."}
    by_model: Dict[str, Dict[str, Any]] = {}
    for r in _rows(path, (now or time.time()) - days * 86400):
        if not r["input"] and not r["output"]:
            continue
        local = (r["provider"] or "").lower() in LOCAL_PROVIDERS
        key = f"{'local' if local else r['provider']}::{r['model']}"
        m = by_model.setdefault(key, {"model": r["model"], "local": local, "tokens": 0, "messages": 0, "saved": 0.0, "paid": 0.0})
        m["tokens"] += r["input"] + r["output"]
        m["messages"] += r["calls"] or 0
        if local:
            m["saved"] += would_have_cost(r["input"], r["output"])
        else:
            m["paid"] += max(r["actual"] or 0, r["estimated"] or 0)
    models = sorted(by_model.values(), key=lambda m: -m["tokens"])
    saved = sum(m["saved"] for m in models)
    paid = sum(m["paid"] for m in models)
    return {
        "ok": True, "days": days, "saved_usd": round(saved, 2), "paid_usd": round(paid, 2),
        "tokens": sum(m["tokens"] for m in models), "messages": sum(m["messages"] for m in models),
        "models": [{"model": m["model"], "on_this_pc": m["local"], "tokens": m["tokens"],
                    **({"saved_usd": round(m["saved"], 2)} if m["local"] else {"charged_usd": round(m["paid"], 2)})} for m in models[:6]],
        "how": (f"An estimate: what the same words would cost on a typical paid AI API (${REFERENCE_PRICE['in_per_million']:g} per million "
                f"tokens read, ${REFERENCE_PRICE['out_per_million']:g} per million written). Answers made on this PC cost nothing. "
                "Settings > Usage and savings shows the same figure."),
    }
