"""`vyrse_quiz`: quiz the user one question at a time, tracked live in VYRSE's workspace.

The plugin keeps the quiz (questions, the right answers, what the user said) so a small model only has to
ask, judge each answer and pass it on: every answer updates the quiz card, and the last one turns into a
scorecard (score, per-topic bars, weak spots to review) without the model having to build it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_quiz",
    "description": (
        "Quiz the user (revision, 'quiz me', 'test me on my notes'), tracked live in VYRSE's workspace. "
        "action=start with subject and 3-10 questions, as text (one per line: 'question :: correct answer :: "
        "topic :: option | option | option | option' — ALWAYS give 4 short options, one of them the correct answer; the "
        "user taps one on screen) or questions [{question, answer, topic, choices}] (the answer stays hidden); "
        "it stays hidden), then ask the FIRST question only. When the user's reply answers the question, call "
        "action=answer with what they said and correct=true/false BEFORE you respond; the result tells you "
        "the next question to ask, or that the quiz is over and the scorecard is shown. A message that isn't an "
        "answer (a new request, chit-chat): just reply, don't record anything. action=stop ends early."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["start", "answer", "stop"]},
            "subject": {"type": "string", "description": "start: e.g. 'Physics · Unit 3'."},
            "questions": {
                "type": "array",
                "description": "start: the questions in order.",
                "items": {"type": "object", "properties": {
                    "question": {"type": "string"},
                    "answer": {"type": "string", "description": "The correct answer (hidden from the user)."},
                    "topic": {"type": "string", "description": "Short topic name, for the weak-spot report."},
                    "choices": {"type": "array", "items": {"type": "string"}, "description": "Optional multiple-choice options (include the answer)."},
                }},
            },
            "text": {"type": "string", "description": "start: the questions as lines 'question :: answer :: topic' "
                                                      "(easier than questions)."},
            "answer": {"type": "string", "description": "answer: what the user said."},
            "correct": {"type": "boolean", "description": "answer: whether the user's answer is right."},
            "note": {"type": "string", "description": "answer: optional one-line explanation or working."},
            "review": {"type": "string", "description": "answer/stop: optional advice on what to revise."},
        },
        "required": ["action"],
    },
}

QUIZ_ID = "quiz"
RESULT_ID = "quiz-result"


def _err(message: str) -> str:
    return json.dumps({"success": False, "error": message})


def _text(value: Any, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit]


def _path(session_id: str) -> Optional[Path]:
    from hermes_constants import get_hermes_home

    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(session_id or ""))[:80]
    return Path(get_hermes_home()) / "vyrse" / "quiz" / f"{safe}.json" if safe else None


def load(session_id: str) -> Optional[Dict[str, Any]]:
    path = _path(session_id)
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path and path.is_file() else None
    except (OSError, ValueError):
        return None


def save(session_id: str, quiz: Optional[Dict[str, Any]]) -> None:
    path = _path(session_id)
    if path is None:
        return
    if quiz is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(quiz, ensure_ascii=False), encoding="utf-8")


def quiz_artifact(quiz: Dict[str, Any]) -> Dict[str, Any]:
    """The live quiz card: answered questions marked, the right answer shown only after a wrong one."""
    questions: List[Dict[str, Any]] = []
    for q in quiz["questions"]:
        item: Dict[str, Any] = {"question": q["question"]}
        if q.get("choices"):
            item["choices"] = q["choices"]
        if "given" in q:
            item.update(answer=q["given"] or "(no answer)", correct=q["correct"])
            if not q["correct"] and q.get("answer"):
                item["right_answer"] = q["answer"]
            if q.get("note"):
                item["note"] = q["note"]
        questions.append(item)
    art: Dict[str, Any] = {"id": QUIZ_ID, "title": quiz.get("title") or "Quiz", "kind": "quiz", "quiz": {"questions": questions}}
    if quiz.get("subject"):
        art["quiz"]["subject"] = quiz["subject"]
    current = _next(quiz)
    if current is not None:
        art["quiz"]["current"] = current
    return art


def _choices(raw: Any, answer: str) -> List[str]:
    """Clean multiple-choice options; the right answer is always among them."""
    items = raw if isinstance(raw, list) else re.split(r"\s*\|\s*", str(raw or ""))
    out = [_text(c, 120) for c in items if _text(c, 120)][:6]
    if out and answer and not any(_norm(c) == _norm(answer) for c in out):
        out.insert(len(out) // 2, _text(answer, 120))
    return out if len(out) >= 2 else []


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()


def close_enough(given: str, expected: str) -> bool:
    """The expected answer with a typo or a different ending ("mitchondrion" for "Mitochondria", "ribosome" for
    "Ribosomes"), but not a different word that looks alike ("meiosis" isn't "mitosis")."""
    g, e = _norm(given), _norm(expected)
    if not g or not e or len(e) > 40:
        return False
    if g == e:
        return True
    stem = lambda w: re.sub(r"(ia|ion|ions|on|a|es|s)$", "", w)
    g2, e2 = stem(g), stem(e)
    allowed = 0 if len(e2) < 5 else 1 if len(e2) < 9 else 2
    return _edits(g2, e2) <= allowed


def _edits(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def picked(q: Dict[str, Any], said: str) -> Optional[str]:
    """Which option the user chose: the option's text, or its letter/number ("B", "2", "option b")."""
    choices = q.get("choices") or []
    if not choices:
        return None
    s = _norm(said)
    for c in choices:
        if _norm(c) and (_norm(c) == s or _norm(c) in s):
            return c
    m = re.fullmatch(r"(?:option |answer |my answer is |it s )?([a-f]|[1-6])", s)
    if m:
        k = m.group(1)
        i = ord(k) - 97 if k.isalpha() else int(k) - 1
        if 0 <= i < len(choices):
            return choices[i]
    return None


def scorecard_artifact(quiz: Dict[str, Any], review: str = "") -> Dict[str, Any]:
    answered = [q for q in quiz["questions"] if "given" in q]
    score = sum(1 for q in answered if q["correct"])
    total = len(answered) or 1
    topics: Dict[str, List[bool]] = {}
    for q in answered:
        topics.setdefault(q.get("topic") or "General", []).append(bool(q["correct"]))
    rows = [{"label": t, "value": sum(r) / len(r), "weak": sum(r) / len(r) < 0.6} for t, r in topics.items()]
    weak = [r["label"] for r in rows if r["weak"]]
    frac = score / total
    verdict = ("Perfect." if frac == 1 else "Solid. One gap." if len(weak) == 1 and frac >= 0.6
               else "Solid." if frac >= 0.75 else "Getting there." if frac >= 0.5 else "Needs work.")
    card: Dict[str, Any] = {"score": score, "total": total, "verdict": verdict, "topics": rows[:12]}
    if quiz.get("subject"):
        card["subject"] = quiz["subject"]
    review = review or (f"Review {', '.join(weak)}." if weak else "")
    if review:
        card["review"] = _text(review, 200)
    return {"id": RESULT_ID, "title": f"{quiz.get('title') or 'Quiz'} result", "kind": "scorecard", "scorecard": card}


def _session() -> str:
    from gateway.session_context import get_session_env

    return get_session_env("HERMES_SESSION_ID", "")


def _show(artifact: Dict[str, Any]) -> None:
    from .workspace import deliver

    deliver({"action": "workspace", "op": "show", "artifact": artifact})


def _next(quiz: Dict[str, Any]) -> Optional[int]:
    return next((i for i, q in enumerate(quiz["questions"]) if "given" not in q), None)


def handle(params: Dict[str, Any], **_: Any) -> str:
    from .tools import _in_vyrse_session

    if not _in_vyrse_session():
        return _err("vyrse_quiz only works in the VYRSE app.")
    session = _session()
    if not session:
        return _err("no conversation")
    action = params.get("action")
    try:
        if action == "start":
            return _start(session, params)
        if action == "answer":
            return _answer(session, params)
        if action == "stop":
            return _stop(session, params)
        return _err("action must be start, answer or stop")
    except Exception as exc:  # never crash the agent loop over a quiz
        return _err(f"Quiz problem: {exc}")


def _start(session: str, params: Dict[str, Any]) -> str:
    questions = []
    for q in (params.get("questions") or [])[:20]:
        if isinstance(q, dict) and _text(q.get("question"), 300):
            answer = _text(q.get("answer"), 200)
            questions.append({"question": _text(q["question"], 300), "answer": answer,
                              "topic": _text(q.get("topic"), 60), "choices": _choices(q.get("choices"), answer)})
        elif isinstance(q, str) and q.strip():
            questions.append({"question": _text(q, 300), "answer": "", "topic": ""})
    from .workspace import pairs_from_text

    for fields in pairs_from_text(str(params.get("text") or ""), parts=10)[: 20 - len(questions)]:
        answer = _text(fields[1], 200)
        questions.append({"question": _text(fields[0], 300), "answer": answer,
                          "topic": _text(fields[2], 60) if len(fields) > 2 else "",
                          # 'choice | choice' is split by the line parser too, so every field after the topic is an option
                          "choices": _choices(fields[3:] if len(fields) > 4 else (fields[3] if len(fields) > 3 else ""), answer)})
    for q in questions:
        if not q.get("choices"):
            q.pop("choices", None)
    if not questions:
        return _err("start needs text: one question per line, like \"What is SN2? :: one-step substitution :: "
                    "Mechanisms\\nWhat is chirality? :: non-superimposable mirror images :: Stereochemistry\"")
    subject = _text(params.get("subject"), 60)
    # `open` = the user has replied since the last question (set by the per-turn hook): one answer per reply.
    quiz = {"subject": subject, "title": f"{subject} quiz" if subject else "Quiz", "questions": questions, "open": False}
    save(session, quiz)
    _show(quiz_artifact(quiz))
    return json.dumps({"success": True, "result": (
        f"Quiz card shown ({len(questions)} questions). Write your reply to the user now as plain text (no more "
        f"tools): a short intro and question 1: \"{questions[0]['question']}\""
        + (" (its options are buttons on the card: don't list them; the user taps one or says it)" if questions[0].get("choices") else "")
        + "")})


def _answer(session: str, params: Dict[str, Any]) -> str:
    quiz = load(session)
    if not quiz:
        return _err("No quiz running; start one with action=start.")
    index = _next(quiz)
    if index is None:
        return _err("The quiz is already finished.")
    if not quiz.get("open", True):
        return _err(f"Already recorded; wait for the user's reply. Now just write your reply to the user (plain "
                    f"text, no tools) asking question {index + 1}: \"{quiz['questions'][index]['question']}\"")
    if not isinstance(params.get("correct"), bool):
        return _err("answer needs correct=true or false")
    said = quiz.get("last_user")
    if said is not None and not given_in(_text(params.get("answer"), 200), said):
        quiz["open"] = False
        save(session, quiz)
        return _err("That isn't in what the user just said, so nothing was recorded: they haven't answered. Reply to "
                    "what they actually said (plain text, no tools); the quiz waits.")
    quiz["open"] = False
    q = quiz["questions"][index]
    given = _text(params.get("answer"), 200)
    correct = params["correct"]
    # A multiple-choice answer is marked here, not by the model: the option they picked either is the answer or isn't.
    choice = picked(q, given) or (picked(q, said) if said else None)
    if choice is not None and q.get("answer"):
        given, correct = choice, _norm(choice) == _norm(q["answer"])
    elif not correct and close_enough(given, q.get("answer", "")):
        # the right answer, misspelt ("mitchondrion"): it counts, with the spelling shown
        correct = True
        params["note"] = f"Right (it's spelt {q['answer']})."
    q.update(given=given, correct=correct)
    if params.get("note"):
        q["note"] = _text(params["note"], 300)
    save(session, quiz)
    _show(quiz_artifact(quiz))
    expected = f" The expected answer was: {q['answer']}." if q.get("answer") else ""
    following = _next(quiz)
    if following is not None:
        nxt = quiz["questions"][following]["question"]
        return json.dumps({"success": True, "result": (
            f"Recorded question {index + 1} as {'right' if q['correct'] else 'wrong'}.{expected} Write your reply to the "
            f"user now as plain text (no more tools): say briefly whether they were right (correct them if not), "
            f"then ask question {following + 1}: \"{nxt}\"")})
    return _finish(session, quiz, params, f"Recorded question {index + 1} as {'right' if q['correct'] else 'wrong'}.{expected}")


def _finish(session: str, quiz: Dict[str, Any], params: Dict[str, Any], lead: str) -> str:
    card = scorecard_artifact(quiz, _text(params.get("review"), 200))
    _show(card)
    save(session, None)
    s = card["scorecard"]
    weak = [t["label"] for t in s["topics"] if t["weak"]]
    return json.dumps({"success": True, "result": (
        f"{lead} Quiz over: {s['score']}/{s['total']}; the scorecard is shown in the workspace. Write your reply to "
        f"the user now as plain text (no more tools): their score in one sentence"
        + (f", and that their weak spot is {', '.join(weak)}." if weak else "."))})


def _stop(session: str, params: Dict[str, Any]) -> str:
    quiz = load(session)
    if not quiz:
        return _err("No quiz running.")
    if _next(quiz) == 0:
        save(session, None)
        return json.dumps({"success": True, "result": "Quiz cancelled."})
    return _finish(session, quiz, params, "Stopped early.")


# Messages that aren't an answer to the open question: a new request, chit-chat, a question back.
_NOT_ANSWER = re.compile(
    r"^\s*(?:yo+|hey+|hi+|hello|sup|thanks?|thank you|ok(?:ay)?|cool|nice|lol|bro|wait|"
    r"can you|could you|would you|will you|please|help|make|show|open|play|start|set|remind|log|track|build|create|"
    r"find|search|tell me|quiz me|test me|new quiz|what(?:'s| is) (?:the|my|a|up)|who|why|how (?:do|does|can|is|are|much|many)|i (?:need|want|"
    r"can't|cant|keep|just|did|have|got|spent|slept|ate|went|bought|finished|studied|drank|ran|walked|played|watched)|"
    r"my (?:pc|computer|laptop|phone|gpu|cpu|ram|internet|wifi)|let'?s|switch|turn|change|send|call|check|analy[sz]e|"
    r"plan|graph|chart|good (?:morning|night))\b",
    re.I,
)
_STOPWORDS = {"the", "and", "that", "this", "with", "what", "which", "from", "have", "your", "about", "into", "they",
              "their", "there", "when", "where", "does", "will", "would", "than", "then", "them", "were", "been"}


def on_topic(message: str, question: str, expected: str) -> bool:
    """A long message sharing no real words with the question or its answer isn't an answer to it
    ("I spent 200 on food…" in the middle of an organic chemistry quiz)."""
    words = [w for w in _tokens(message) if len(w) > 3 and w not in _STOPWORDS]
    if len(_tokens(message)) < 8 or not words:
        return True
    topic = {w for w in _tokens(f"{question} {expected}") if len(w) > 3}
    return any(w in topic or any(w[:5] == t[:5] for t in topic if len(t) > 4) for w in words)
_STOP = re.compile(r"\b(stop|end|quit|cancel|exit|enough|get off|no more)\b.{0,20}\b(quiz|questions?|this)\b|"
                   r"^\s*(stop|quit|enough|i'?m done)\s*[.!]*\s*$", re.I)
_RESUME = re.compile(r"\b(continue|resume|back to|carry on)\b.{0,20}\bquiz\b|\bnext question\b|\bwhere were we\b", re.I)


def is_answer(message: str) -> bool:
    """Could this message be an answer to the quiz question? (Short, not a request, a greeting or a question.)"""
    text = (message or "").strip()
    if not text or len(text) > 400:
        return False
    if _NOT_ANSWER.match(text) or _STOP.search(text):
        return False
    return not (text.endswith("?") and len(text.split()) > 3)


def _tokens(text: str) -> List[str]:
    return re.findall(r"[a-z0-9]+(?:\.[0-9]+)?", text.lower())


def given_in(given: str, said: str) -> bool:
    """The answer the model passes must come from what the user typed (a model once made up "56" for "yo what's up")."""
    words = [w for w in _tokens(given) if len(w) > 1 or w.isdigit()]
    if not words or re.fullmatch(r"\s*(\(no answer\)|idk|i don'?t know|skip|pass|no idea)\s*", given, re.I):
        return True
    heard = set(_tokens(said))
    return any(w in heard for w in words)


def pre_llm_call(platform: str = "", session_id: str = "", user_message: Any = "", **_: Any) -> Optional[Dict[str, str]]:
    """While a quiz runs, tell the model each turn whether the user's message is an answer to record (small
    models otherwise forget the tool) or something else to reply to (they used to record a made-up answer)."""
    if platform != "vyrse" or not session_id:
        return None
    quiz = load(session_id)
    index = _next(quiz) if quiz else None
    if index is None:
        return None
    q = quiz["questions"][index]
    said = str(user_message or "")
    quiz["last_user"] = said[:2000]
    if _STOP.search(said):
        quiz["open"] = False
        save(session_id, quiz)
        return {"context": "[The user wants to stop the quiz: call vyrse_quiz action=stop, then reply to the rest of "
                           "their message.]"}
    if _RESUME.search(said):
        quiz.update(open=False, off_topic=0, dormant=False)
        save(session_id, quiz)
        return {"context": f"[Back to the quiz: ask question {index + 1} again: \"{q['question']}\". Don't call vyrse_quiz yet.]"}
    # A multiple-choice answer (tapped in the card: "My answer: …", or typed as the option / its letter) is
    # marked right here, so it never depends on the model calling the tool.
    tapped = re.match(r"\s*my answer:\s*(.+)$", said, re.I | re.S)
    choice = picked(q, tapped.group(1)) if tapped else picked(q, said)
    if choice is not None and not tapped and len(_norm(said)) > len(_norm(choice)) + 14:
        choice = None  # a longer message that only mentions an option isn't picking it
    if choice is not None and q.get("answer"):
        return _mark_choice(session_id, quiz, index, choice)
    if not is_answer(said) or not on_topic(said, q["question"], q.get("answer", "")):
        # Off topic: the quiz pauses. After two such messages in a row it goes quiet until they come back to it.
        was_dormant = bool(quiz.get("dormant"))
        quiz["off_topic"] = int(quiz.get("off_topic") or 0) + 1
        quiz.update(open=False, dormant=quiz["off_topic"] >= 2)
        save(session_id, quiz)
        if was_dormant:
            return None
        return {"context": (
            f"[A quiz is paused at question {index + 1}. This message is NOT an answer: don't call vyrse_quiz; just "
            "reply to what they said. " + ("You may mention the quiz is waiting, in a few words." if quiz["off_topic"] == 1 else
                                          "Don't mention the quiz again unless they bring it up.") + "]")}
    # Looks like an answer (even after the quiz went quiet): open it for one answer, which must come from this message.
    quiz.update(open=True, off_topic=0, dormant=False)
    save(session_id, quiz)
    return {"context": (
        f"[Quiz in progress: question {index + 1} of {len(quiz['questions'])} was \"{q['question']}\" "
        f"(expected: {q.get('answer') or 'judge it yourself'}). If this message answers it, FIRST call "
        "vyrse_quiz action=answer with their answer and correct=true/false; then reply as the tool result says. "
        "If they want to stop, call action=stop.]")}


def _mark_choice(session_id: str, quiz: Dict[str, Any], index: int, choice: str) -> Dict[str, str]:
    from .workspace import deliver

    q = quiz["questions"][index]
    right = _norm(choice) == _norm(q["answer"])
    q.update(given=choice, correct=right)
    quiz.update(open=False, off_topic=0, dormant=False)
    following = _next(quiz)
    verdict = "RIGHT" if right else f"WRONG (the answer is {q['answer']})"
    deliver({"action": "workspace", "op": "show", "artifact": quiz_artifact(quiz)}, session=session_id)
    if following is None:
        card = scorecard_artifact(quiz)
        save(session_id, None)
        deliver({"action": "workspace", "op": "show", "artifact": card}, session=session_id)
        s = card["scorecard"]
        weak = [t["label"] for t in s["topics"] if t["weak"]]
        return {"context": (
            f"[Quiz: for question {index + 1} the user picked \"{choice}\": {verdict}. That was the last one; it's "
            f"recorded and the scorecard ({s['score']}/{s['total']}) is on screen. Don't call vyrse_quiz. Reply in two "
            f"sentences: whether this one was right" + (", one line why" if not right else "") + ", then their score"
            + (f" and that {', '.join(weak)} is the thing to revise." if weak else ".") + "]")}
    save(session_id, quiz)
    return {"context": (
        f"[Quiz: for question {index + 1} the user picked \"{choice}\": {verdict}. It's recorded and shown on the "
        f"card. Don't call vyrse_quiz. Reply briefly: " + ("well done" if right else "correct them in one line") +
        f", then ask question {following + 1}: \"{quiz['questions'][following]['question']}\" (its options are on "
        "screen; don't list them).]")}


_WRONG = re.compile(r"\b(not (quite |exactly )?(right|correct)|incorrect|wrong|close,? but|isn't (right|correct)|that's not|"
                    r"not quite|almost|unfortunately)\b", re.I)
_RIGHT = re.compile(r"\b(correct(?! answer)|(that's|you're|you are|that is) (absolutely |exactly )?right|right!|exactly|"
                    r"well done|nailed it|spot on|perfect|great answer|good answer|yes)\b", re.I)


def judge(reply: str) -> Optional[bool]:
    """Right or wrong, from how the reply opens ('Not quite…', 'Correct!'); None when it doesn't say."""
    head = (reply or "")[:240]
    if _WRONG.search(head):
        return False
    if _RIGHT.search(head):
        return True
    return None


def post_llm_call(platform: str = "", session_id: str = "", user_message: Any = "", assistant_response: Any = "",
                  **_: Any) -> None:
    """Safety net: the user answered and the reply judged it, but the model didn't record it — record it."""
    if platform != "vyrse" or not session_id:
        return
    quiz = load(session_id)
    index = _next(quiz) if quiz else None
    if index is None or not quiz.get("open") or not is_answer(str(user_message or "")):
        return
    asked = quiz["questions"][index]
    if not on_topic(str(user_message or ""), asked["question"], asked.get("answer", "")):
        return
    verdict = judge(str(assistant_response or ""))
    if verdict is None:
        return
    q = quiz["questions"][index]
    q.update(given=_text(user_message, 200), correct=verdict)
    quiz["open"] = False
    from .workspace import deliver

    if _next(quiz) is None:
        save(session_id, None)
        deliver({"action": "workspace", "op": "show", "artifact": quiz_artifact(quiz)}, session=session_id)
        deliver({"action": "workspace", "op": "show", "artifact": scorecard_artifact(quiz)}, session=session_id)
    else:
        save(session_id, quiz)
        deliver({"action": "workspace", "op": "show", "artifact": quiz_artifact(quiz)}, session=session_id)
