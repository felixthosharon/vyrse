"""The now-playing pill follows music VYRSE started, on every device; a single song carries on when it ends."""
from vyrse import media_state
from vyrse.controls import _song_ended, carry_on_query


def _home(tmp_path, monkeypatch):
    monkeypatch.setattr(media_state, "_path", lambda: tmp_path / "vyrse" / "media.json")


def test_claim_note_and_release(tmp_path, monkeypatch):
    _home(tmp_path, monkeypatch)
    assert media_state.load()["owned"] is False
    s = media_state.claim({"app": "Spotify", "title": "Blinding Lights", "artist": "The Weeknd"}, {"query": "blinding lights", "kind": "Song"})
    assert s["owned"] and s["version"] == 1
    # the same song still playing: nothing for the apps to re-read
    assert media_state.note({"playing": True, "app": "Spotify.exe", "title": "Blinding Lights", "artist": "The Weeknd"})["version"] == 1
    # the next song: the version moves so every device updates
    s = media_state.note({"playing": True, "app": "Spotify.exe", "title": "Save Your Tears", "artist": "The Weeknd"})
    assert s["version"] == 2 and s["title"] == "Save Your Tears" and s["owned"]
    # another app playing: not VYRSE's music any more
    s = media_state.note({"playing": True, "app": "chrome.exe", "title": "Some video"})
    assert s["owned"] is False and s["released"] == "other app"
    media_state.claim({"app": "Spotify", "title": "x"})
    assert media_state.release()["owned"] is False


def test_long_silence_ends_the_claim(tmp_path, monkeypatch):
    _home(tmp_path, monkeypatch)
    media_state.claim({"app": "Spotify", "title": "x"})
    st = media_state.load()
    st["last_playing"] -= media_state.IDLE_S + 5
    media_state._save(st)
    assert media_state.note({"playing": False, "app": "Spotify", "title": "x"})["owned"] is False


def test_a_song_that_ran_out_is_told_apart_from_a_pause():
    playing = {"playing": True, "title": "A", "position": 198.0, "length": 200.0}
    assert _song_ended(playing, {"playing": False, "title": "A", "position": 200.0, "length": 200.0})
    assert _song_ended(playing, {"playing": False, "title": "A", "position": 0.0, "length": 200.0})
    # paused halfway by the user
    assert not _song_ended({"playing": True, "title": "A", "position": 90.0, "length": 200.0},
                           {"playing": False, "title": "A", "position": 92.0, "length": 200.0})
    # something else came on, or it still plays
    assert not _song_ended(playing, {"playing": False, "title": "B", "position": 0.0, "length": 180.0})
    assert not _song_ended(playing, {"playing": True, "title": "A", "position": 199.0, "length": 200.0})


def test_carry_on_with_the_main_artist():
    assert carry_on_query("Blinding Lights", "The Weeknd") == "The Weeknd"
    assert carry_on_query("Die With A Smile", "Lady Gaga, Bruno Mars") == "Lady Gaga"
    assert carry_on_query("Song", "Drake feat. Rihanna") == "Drake"
    assert carry_on_query("Lonely Song", "") == "Lonely Song"
