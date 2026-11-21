import { describe, expect, it } from "vitest";
import { mediaAppName } from "../NowPlaying";

describe("mediaAppName", () => {
  it("turns Windows' app ids into names people know", () => {
    expect(mediaAppName("Spotify.exe")).toBe("Spotify");
    expect(mediaAppName("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify")).toBe("Spotify");
    expect(mediaAppName("chrome.exe")).toBe("Chrome");
    expect(mediaAppName("MSEdge")).toBe("Edge");
    expect(mediaAppName("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic")).toBe("Media Player");
    expect(mediaAppName("foobar2000.exe")).toBe("Foobar2000");
    expect(mediaAppName(undefined)).toBe("");
  });
});
