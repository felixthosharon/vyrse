"""Every VYRSE tool loads up front: a tool left off setup.ps1's eager list hides behind tool search and a local
model never finds it (this is how pointing, captions, the HUD and break-it-down silently went unused)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_every_registered_tool_is_eager():
    registered = set(re.findall(r'name="(vyrse_[a-z_]+)"', (ROOT / "hermes-plugin" / "vyrse" / "__init__.py").read_text(encoding="utf-8")))
    setup = (ROOT / "scripts" / "setup.ps1").read_text(encoding="utf-8-sig")
    block = setup[setup.index("$VyrseEager = @("):]
    block = block[: block.index(")")]
    eager = set(re.findall(r"'(vyrse_[a-z_]+)'", block))
    assert registered and registered <= eager, f"not eager: {sorted(registered - eager)}"
