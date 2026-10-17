"""Show me where / ghost hands captions, break-it-down reading and recipes, live-caption silence handling."""
import zipfile


def test_steps_and_ghost_captions():
    from vyrse import point

    steps = point._steps("1. File :: open it\n- Export :: choose PDF\n\n")
    assert steps == [{"target": "File", "caption": "open it"}, {"target": "Export", "caption": "choose PDF"}]
    assert point.ghost_caption("vyrse_desktop", {"action": "click", "name": "Save"}) == "Clicking Save"
    assert point.ghost_caption("vyrse_desktop", {"action": "type", "text": "x" * 60}).endswith("…”")
    assert point.ghost_caption("vyrse_desktop", {"action": "windows"}) is None
    assert point.ghost_caption("terminal", {}) is None


def test_digest_reads_docx_and_picks_cards(tmp_path):
    from vyrse import digest

    f = tmp_path / "terms.docx"
    with zipfile.ZipFile(f, "w") as z:
        z.writestr("word/document.xml", '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Service Agreement</w:t></w:r></w:p>'
                   "<w:p><w:r><w:t>Either party may terminate. Liability is limited. Governing law applies.</w:t></w:r></w:p></w:body></w:document>")
    got = digest.extract(f)
    assert got["kind"] == "document" and "Service Agreement\nEither party" in got["text"]
    assert digest.recipe(got["kind"], got["text"]).startswith("Agreement/terms")
    assert digest.recipe("document", "Subtotal 760\nGST 38\nTotal 798").startswith("Receipt")
    assert digest.recipe("code", "def f(): pass").startswith("Code")
    assert digest.extract(tmp_path / "terms.docx")["meta"]["name"] == "terms.docx"
    (tmp_path / "data.csv").write_text("a,b\n1,2")
    assert digest.extract(tmp_path / "data.csv")["kind"] == "data"


def test_captions_ignore_silence_and_short_audio():
    from vyrse import captions

    assert captions.chunk(b"\x00\x00" * 4000) == {"text": ""}  # too short
    assert captions.chunk(b"\x00\x00" * 32000) == {"text": ""}  # silent
