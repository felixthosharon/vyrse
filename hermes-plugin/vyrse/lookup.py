"""Look it up instead of making it up: the real steps for doing something in an app, from the web.

For "show me how to turn on dark mode in Discord", VYRSE searches the web, reads the best pages (official help
pages first) and pulls out only the steps those pages actually give, with their links. The model then points
at them one by one (vyrse_point action=steps). Never runs in Private mode (privacy.py blocks it).
"""
from __future__ import annotations

import html
import json
import logging
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any, Dict, List
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_OFFICIAL = re.compile(r"(^|\.)(support|help|docs|learn|answers|community)\.|support\.google\.com|support\.microsoft\.com|"
                       r"helpx\.adobe\.com|support\.apple\.com|support\.discord\.com|faq\.whatsapp\.com", re.I)


def _search(query: str) -> List[Dict[str, Any]]:
    """Web results for a how-to: Hermes' configured search, else DuckDuckGo's plain page, else Bing's. (Hermes'
    keyless search needs a package its runtime may lack; a lookup must not depend on that.)"""
    results: List[Dict[str, Any]] = []
    try:
        from tools.web_tools import web_search_tool

        data = json.loads(web_search_tool(query, 6))
        results = list((data.get("data") or {}).get("web") or [])
    except Exception as exc:
        logger.info("vyrse: Hermes web search failed: %s", exc)
    for engine in (_duckduckgo, _bing):
        if results:
            break
        try:
            results = engine(query)
        except Exception as exc:
            logger.info("vyrse: %s search failed: %s", engine.__name__, exc)
    return results


def _get(url: str, data: bytes = None) -> str:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": _UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=12) as resp:
        return resp.read(1_500_000).decode(resp.headers.get_content_charset() or "utf-8", errors="replace")


def _clean(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment or "")).strip()


def _duckduckgo(query: str) -> List[Dict[str, Any]]:
    page = _get("https://html.duckduckgo.com/html/", urllib.parse.urlencode({"q": query}).encode())
    out = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]+class="result__a"|$)', page, re.S):
        href = html.unescape(m.group(1))
        target = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg", [href])[0]
        if not target.startswith("http") or "duckduckgo.com/y.js" in target:
            continue  # ads
        snippet = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', m.group(3), re.S)
        out.append({"title": _clean(m.group(2)), "url": target, "description": _clean(snippet.group(1)) if snippet else ""})
        if len(out) >= 6:
            break
    return out


def _bing(query: str) -> List[Dict[str, Any]]:
    page = _get("https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "setlang": "en"}))
    out = []
    for m in re.finditer(r'<li class="b_algo"[^>]*>.*?<h2[^>]*><a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>(.*?)</li>', page, re.S):
        para = re.search(r"<p[^>]*>(.*?)</p>", m.group(3), re.S)
        url = html.unescape(m.group(1))
        if "bing.com/ck/a" in url:  # Bing's click redirect: the real address is base64 in u=a1...
            import base64

            u = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("u", [""])[0]
            try:
                url = base64.urlsafe_b64decode(u[2:] + "=" * (-len(u[2:]) % 4)).decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                continue
        out.append({"title": _clean(m.group(2)), "url": url, "description": _clean(para.group(1)) if para else ""})
        if len(out) >= 6:
            break
    return out


_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 "
       "Safari/537.36")


class _Text(HTMLParser):
    """A help page's readable text: <main>/<article> when the page has one, without scripts, menus and footers."""

    SKIP = {"script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "template"}
    BLOCK = {"p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "br", "div", "tr", "section", "ol", "ul", "dt", "dd"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.main = 0
        self.all: List[str] = []
        self.inside: List[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag in ("main", "article"):
            self.main += 1
        if tag in self.BLOCK:
            self._add("\n")
        if tag == "li":
            self._add("- ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag in ("main", "article") and self.main:
            self.main -= 1
        if tag in self.BLOCK:
            self._add("\n")

    def handle_data(self, data):
        if not self.skip and data.strip():
            self._add(re.sub(r"\s+", " ", data))

    def _add(self, text: str) -> None:
        self.all.append(text)
        if self.main:
            self.inside.append(text)

    def text(self) -> str:
        body = "".join(self.inside) if len("".join(self.inside).strip()) > 400 else "".join(self.all)
        return re.sub(r"\n\s*\n+", "\n", body).strip()


def _fetch_text(url: str, limit: int = 2_000_000) -> str:
    if urlparse(url).scheme not in ("http", "https"):
        return ""
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=12) as resp:
        if "html" not in str(resp.headers.get("Content-Type") or "html"):
            return ""
        raw = resp.read(limit)
        charset = resp.headers.get_content_charset() or "utf-8"
    parser = _Text()
    parser.feed(raw.decode(charset, errors="replace"))
    return parser.text()


def _extract(urls: List[str]) -> List[Dict[str, Any]]:
    """Each page's readable text (pages that fail to load are left out)."""
    pages = []
    for url in urls:
        try:
            text = _fetch_text(url)
        except Exception as exc:
            logger.info("vyrse: lookup couldn't read %s: %s", url, exc)
            continue
        if text:
            pages.append({"url": url, "content": text})
    return pages


def _pick(results: List[Dict[str, Any]], n: int = 2) -> List[Dict[str, Any]]:
    ranked = sorted(enumerate(results), key=lambda p: (not _OFFICIAL.search(urlparse(str(p[1].get("url") or "")).netloc), p[0]))
    return [r for _, r in ranked if str(r.get("url") or "").startswith("http")][:n]


def _steps_from(text: str, app: str, goal: str) -> str:
    """Only the steps the page itself gives (the local model copies them out; it may answer NONE)."""
    from agent.auxiliary_client import call_llm, extract_content_or_reasoning

    prompt = (
        f"Below is the text of a help page. Copy out the steps it gives for: \"{goal}\" in {app or 'the app'}.\n"
        "Rules: use only what the page says. One step per line as '<control> :: <what to do>', where <control> is "
        "ONLY the name of the button, menu, tab or setting to use, exactly as the page writes it (e.g. 'References', "
        "'Insert Table of Contents', 'User Settings'), never a sentence. A step with no control to click (like "
        "'click where you want it') goes in the next step's text. At most 8 steps, Windows/desktop version if the "
        "page has several. If the page doesn't give those steps, or they're for a different app, reply exactly "
        "NONE.\n\n---\n" + text[:9000]
    )
    resp = call_llm(task="vision", messages=[{"role": "user", "content": prompt}], max_tokens=500, temperature=0,
                    timeout=90, extra_body={"chat_template_kwargs": {"enable_thinking": False}})
    return str(extract_content_or_reasoning(resp) or "").strip()


def how_to(app: str, goal: str) -> Dict[str, Any]:
    app = re.sub(r"\s*\((?:website|web)\)$", "", app or "").strip()
    query = f"{app} how to {goal}".strip() if app else f"how to {goal}"
    web_app = bool(re.search(r"for the web|online|google (?:docs|sheets|slides)|gmail|\.\w{2,3}$|website", app, re.I))
    try:
        results = _search(query if web_app or "windows" in query.lower() else query + " windows")
    except Exception as exc:
        return {"ok": False, "error": f"Couldn't search the web: {exc}"}
    if not results:
        return {"ok": False, "error": f"No web results for '{query}'."}
    chosen = _pick(results)
    try:
        pages = _extract([str(r["url"]) for r in chosen])
    except Exception as exc:
        logger.warning("vyrse: lookup extract failed: %s", exc)
        pages = []
    for page in pages:
        text = str(page.get("content") or page.get("text") or page.get("raw_content") or "")
        if len(text) < 200:
            continue
        try:
            steps = _steps_from(text, app, goal)
        except Exception as exc:
            logger.warning("vyrse: lookup step extraction failed: %s", exc)
            continue
        if steps and steps.upper() != "NONE" and "::" in steps:
            return {"ok": True, "steps": steps, "source": page.get("url") or page.get("title"),
                    "note": "These steps come from that page. Point at them with vyrse_point action=steps (pass these "
                            "lines), or in Chrome with vyrse_chrome point, one at a time. If a label isn't on screen, "
                            "say so rather than guessing."}
    return {"ok": False, "error": "The pages I found don't give clear steps for that.",
            "results": [{"title": r.get("title"), "url": r.get("url"), "snippet": str(r.get("description") or "")[:200]}
                        for r in results[:4]],
            "note": "Tell the user what you found (with the links) rather than guessing the steps."}
