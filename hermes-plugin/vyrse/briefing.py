"""Daily briefing: one tool call gathers what a morning rundown needs, in parallel, in a few seconds.

Weather (wttr.in, located by IP unless a place is given), today's reminders (Hermes cron), a few
headlines (ddgs news) and PC health only when something needs attention. Private mode skips everything
that goes online. The model turns the result into a short spoken briefing in the current talk style.
"""
from __future__ import annotations

import json
import logging
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Dict, List, Optional

TIMEOUT_S = 5.0


def _private() -> bool:
    try:
        from . import ui_state

        return ui_state.load().get("mode") == "private"
    except Exception:
        return False


# A country is too vague for weather (wttr.in matched "India" to a small town); locate by IP instead.
_TOO_VAGUE = {"india", "bharat", "in", "ist", "usa", "us", "uk", "earth", "home", "here", "my city", "local"}


def weather(location: str = "") -> Optional[Dict[str, Any]]:
    if location.strip().lower() in _TOO_VAGUE:
        location = ""
    place = urllib.parse.quote(location.strip()) if location.strip() else ""
    req = urllib.request.Request(f"https://wttr.in/{place}?format=j1", headers={"User-Agent": "curl/8 (VYRSE)"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    now = (data.get("current_condition") or [{}])[0]
    today = (data.get("weather") or [{}])[0]
    area = (data.get("nearest_area") or [{}])[0]
    rain = max((int(h.get("chanceofrain", 0) or 0) for h in today.get("hourly", [])), default=0)
    return {
        "place": ((area.get("areaName") or [{}])[0].get("value") or location or "").strip(),
        "now": ((now.get("weatherDesc") or [{}])[0].get("value") or "").strip(),
        "temp_c": now.get("temp_C"),
        "feels_like_c": now.get("FeelsLikeC"),
        "humidity": now.get("humidity"),
        "high_c": today.get("maxtempC"),
        "low_c": today.get("mintempC"),
        "max_chance_of_rain": rain,
    }


_AI_QUERY = '"artificial intelligence" OR OpenAI OR Anthropic OR "Google DeepMind" OR Nvidia OR "AI model" when:1d'
_TECH_FEED = "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en"
# One gaming story a day (popular games first).
def _games_query() -> str:
    """The user's own games (Settings: briefing games, e.g. "Valorant, Minecraft"), else general gaming news."""
    try:
        from . import ui_state

        games = [g.strip() for g in str(ui_state.load().get("briefingGames") or "").split(",") if g.strip()][:5]
    except Exception:
        games = []
    terms = " OR ".join(f'"{g}"' if " " in g else g for g in games) if games else '"video games" OR gaming'
    return f"{terms} when:2d"
_SHOPPING = re.compile(r"\b(deals?|prime (big deal )?days?|discounts?|sale|coupons?|best .* to buy)\b", re.IGNORECASE)


def _feed(url: str) -> List[Dict[str, str]]:
    import xml.etree.ElementTree as ET

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (VYRSE)"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        root = ET.fromstring(resp.read())
    out = []
    for item in root.iter("item"):
        raw = (item.findtext("title") or "").strip()
        source = (item.findtext("source") or "").strip()
        title = raw[: -len(source) - 3].strip() if source and raw.endswith(f" - {source}") else raw
        if title:
            out.append({"title": title, "source": source})
    return out


def _words(title: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if len(w) > 3}


def headlines(topic: str = "", limit: int = 4) -> List[Dict[str, str]]:
    """Global news from Google News RSS: AI first, then general tech and one gaming story (or a topic asked for)."""
    if topic.strip():
        q = urllib.parse.quote(f"{topic.strip()} when:1d")
        pools = [_feed(f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en")]
        quotas = [limit]
    else:
        search = "https://news.google.com/rss/search?q={}&hl=en-US&gl=US&ceid=US:en"
        urls = [search.format(urllib.parse.quote(_AI_QUERY)), _TECH_FEED, search.format(urllib.parse.quote(_games_query()))]

        def safe(url: str) -> List[Dict[str, str]]:
            try:
                return _feed(url)
            except Exception as exc:  # one dead feed shouldn't empty the briefing
                logging.getLogger(__name__).warning("vyrse briefing: feed failed (%s): %s", url[:60], exc)
                return []

        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=3) as pool:
            pools = list(pool.map(safe, urls))
        quotas = [max(1, limit - 2), 1, 1]
    out: List[Dict[str, str]] = []
    for pool, quota in zip(pools, quotas):
        taken = 0
        for row in pool:
            if taken >= quota:
                break
            if _SHOPPING.search(row["title"]):
                continue
            # The same story from two outlets reads like a repeat; keep the first.
            if any(len(_words(row["title"]) & _words(o["title"])) >= 2 for o in out):
                continue
            out.append(row)
            taken += 1
    return out


def reminders_today() -> List[Dict[str, str]]:
    from cron.jobs import list_jobs

    today = datetime.now().date()
    out = []
    for job in list_jobs():
        nxt = job.get("next_run_at")
        when: Optional[datetime] = None
        try:
            if isinstance(nxt, (int, float)):
                when = datetime.fromtimestamp(nxt)
            elif isinstance(nxt, str) and nxt:
                when = datetime.fromisoformat(nxt.replace("Z", "+00:00")).astimezone()
        except Exception:
            when = None
        if when and when.date() == today:
            out.append({"name": str(job.get("name") or "reminder"), "at": when.strftime("%H:%M")})
    return sorted(out, key=lambda r: r["at"])


def pc_health() -> List[str]:
    import psutil

    notes = []
    for part in psutil.disk_partitions(all=False):
        try:
            use = psutil.disk_usage(part.mountpoint)
        except Exception:
            continue
        if use.percent >= 90:
            notes.append(f"Drive {part.mountpoint.rstrip(chr(92))} is {use.percent:.0f}% full ({use.free / 2**30:.0f} GB free)")
    ram = psutil.virtual_memory()
    if ram.percent >= 85:
        notes.append(f"RAM is at {ram.percent:.0f}% already")
    return notes


def gather(location: str = "", news_topic: str = "") -> Dict[str, Any]:
    now = datetime.now()
    hour = now.hour
    result: Dict[str, Any] = {
        "local_time": now.strftime("%A %d %B, %H:%M"),
        "part_of_day": "morning" if 4 <= hour < 12 else "afternoon" if hour < 17 else "evening" if hour < 22 else "night",
    }
    private = _private()
    jobs = {"reminders_today": reminders_today, "pc_attention": pc_health}
    if private:
        result["note"] = "Private mode: weather and news were skipped (they need the internet)."
    else:
        jobs["weather"] = lambda: weather(location)
        jobs["headlines"] = lambda: headlines(news_topic)
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {name: pool.submit(fn) for name, fn in jobs.items()}
        for name, fut in futures.items():
            try:
                result[name] = fut.result(timeout=max(0.5, TIMEOUT_S + 2 - (time.monotonic() - started)))
            except Exception as exc:
                # Unavailable right now; the briefing just leaves it out.
                logging.getLogger(__name__).warning("vyrse briefing: %s failed: %r", name, exc)
                result[name] = None
    return result


HOW_TO_SPEAK = (
    "Turn this into a short spoken briefing in the current talk style: greet the user by name for the part of day, "
    "then weather (now, high/low, rain only if likely), today's reminders, anything under pc_attention, and "
    "the AI/tech headlines in a few words each (they are global, not local news). About 5-7 sentences, no lists or markdown. Skip anything missing "
    "without mentioning it failed."
)


def _weather_icon(desc: str) -> str:
    d = desc.lower()
    for words, icon in ((("thunder", "storm"), "storm"), (("snow", "sleet", "ice"), "snow"),
                        (("rain", "drizzle", "shower"), "rain"), (("cloud", "overcast", "mist", "fog"), "cloud")):
        if any(w in d for w in words):
            return icon
    return "sun"


def cards(data: Dict[str, Any]) -> Dict[str, Any]:
    """The briefing as glass cards for the workspace: weather, today, headlines, the PC."""
    items: List[Dict[str, Any]] = []
    w = data.get("weather") or {}
    if w.get("temp_c") not in (None, ""):
        bits = [w.get("now") or ""]
        if w.get("high_c") and w.get("low_c"):
            bits.append(f"H {w['high_c']}° · L {w['low_c']}°")
        if int(w.get("max_chance_of_rain") or 0) >= 40:
            bits.append(f"{w['max_chance_of_rain']}% rain")
        items.append({"label": f"Weather{' · ' + w['place'] if w.get('place') else ''}", "value": f"{w['temp_c']}°",
                      "detail": " · ".join(b for b in bits if b), "icon": _weather_icon(w.get("now") or "")})
    rem = data.get("reminders_today") or []
    items.append({"label": "Today", "icon": "calendar",
                  "detail": "\n".join(f"{r['at']} · {r['name']}" for r in rem[:5]) if rem else "Nothing scheduled"})
    news = data.get("headlines") or []
    if news:
        items.append({"label": "Headlines", "icon": "news", "detail": "\n".join(n["title"] for n in news[:3])})
    pc = data.get("pc_attention")
    if pc is not None:
        items.append({"label": "Your PC", "icon": "alert" if pc else "shield",
                      "detail": "\n".join(pc) if pc else "All good"})
    title = f"Your {data.get('part_of_day') or 'day'} · {data.get('local_time', '')}".strip(" ·")
    return {"id": "briefing", "kind": "cards", "title": title,
            "cards": [{k: (v[:400] if isinstance(v, str) else v) for k, v in i.items()} for i in items]}


def handle(params: Dict[str, Any], **_: Any) -> str:
    data = gather(str(params.get("location") or ""), str(params.get("news_topic") or ""))
    try:
        from .tools import _in_vyrse_session

        if _in_vyrse_session():
            from . import workspace

            workspace.deliver({"action": "workspace", "op": "show", "artifact": cards(data)})
    except Exception as exc:  # the spoken briefing works without the cards
        logging.getLogger(__name__).warning("vyrse briefing: cards failed: %r", exc)
    return json.dumps({"briefing": data, "how_to_present": HOW_TO_SPEAK + " The details are on screen as cards too."}, ensure_ascii=False)


# Short messages that mean "brief me". The model often treats a bare "good morning" as small talk
# (especially late at night), so the hint makes the briefing deterministic.
_ASKS = re.compile(
    r"^\s*(?:yo+\s+|hey\s+|hi\s+)?(?:good\s*morning|g\s*m|mornin[g']?|morning briefing|daily briefing|brief me|"
    r"briefing|what'?s my day (?:like|look(?:ing)? like)|what'?s on today|what'?s up today)\b",
    re.IGNORECASE,
)


def wants_briefing(message: str) -> bool:
    text = (message or "").strip()
    return len(text) <= 48 and bool(_ASKS.match(text))


def pre_llm_call(platform: str = "", user_message: Any = None, **_: Any) -> Optional[Dict[str, str]]:
    """Hermes `pre_llm_call` hook: a bare "good morning" in VYRSE gets the daily briefing."""
    if platform != "vyrse" or not isinstance(user_message, str) or not wants_briefing(user_message):
        return None
    return {"context": "[VYRSE] The user is asking for their daily briefing: call `vyrse_briefing` now, then speak it."}
