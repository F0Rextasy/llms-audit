"""Render assets/demo.gif + assets/demo.png from REAL llms-audit CLI output.

Spawns fixtures/server.ts twice (unready + ready), runs the CLI against each,
plus --fix-llms, and renders cumulative terminal frames (PIL family recipe).
"""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "src" / "cli.ts"
SRV = ROOT / "fixtures" / "server.ts"
ASSETS = ROOT / "assets"

BG = (13, 17, 23)
FG = (201, 209, 217)
PROMPT = (108, 118, 133)
SUCCESS = (126, 231, 135)
WARN = (227, 179, 65)
ERROR = (255, 123, 114)
KEY = (121, 192, 255)

DURATIONS = [1000, 650, 650, 650, 650, 750, 950]

FONT_CANDIDATES = [
    "C:/Windows/Fonts/consola.ttf",
    "C:/Windows/Fonts/cour.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]


def find_font():
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    raise FileNotFoundError("no monospace TTF font found")


def start_server(port: int, ready: bool):
    env = {**os.environ, "PORT": str(port)}
    if ready:
        env["READY"] = "1"
    proc = subprocess.Popen(
        ["bun", str(SRV)], cwd=ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    for _ in range(50):
        line = proc.stdout.readline()
        if "listening" in line:
            return proc
        if proc.poll() is not None:
            raise RuntimeError(f"server died: {line}")
        time.sleep(0.05)
    raise RuntimeError("server never listened")


def run_cli(*args):
    p = subprocess.run(["bun", str(CLI), *args], cwd=ROOT, capture_output=True, text=True, timeout=60)
    return p.stdout.strip() or p.stderr.strip()


def line_color(ln: str) -> tuple:
    if ln.startswith("score"):
        return KEY
    if "PASS" in ln:
        return SUCCESS
    if "FAIL" in ln:
        return ERROR
    if "WARN" in ln:
        return WARN
    if ln.startswith(("check", "---")):
        return PROMPT
    return FG


def main():
    from PIL import Image, ImageDraw, ImageFont

    servers = []
    steps = []
    try:
        servers.append(start_server(8790, False))
        servers.append(start_server(8791, True))

        out = run_cli("http://127.0.0.1:8790")
        steps.append([("$ llms-audit http://127.0.0.1:8790", PROMPT)] +
                     [(ln, line_color(ln)) for ln in out.splitlines()])
        out = run_cli("http://127.0.0.1:8791")
        steps.append([("$ llms-audit http://127.0.0.1:8791", PROMPT)] +
                     [(ln, line_color(ln)) for ln in out.splitlines()])
        out = run_cli("https://acme.test", "--fix-llms")
        tmpl = out.splitlines()[:6]
        steps.append([("$ llms-audit https://acme.test --fix-llms", PROMPT)] +
                     [(ln, KEY if ln.startswith("#") else FG if not ln.startswith("##") else WARN)
                      for ln in tmpl] +
                     [("…", PROMPT)])
    finally:
        for s in servers:
            try:
                s.send_signal(signal.SIGTERM)
                s.wait(timeout=3)
            except Exception:
                s.kill()

    font = ImageFont.truetype(find_font(), 15)
    tmp = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    max_w, max_lines = 0, 0
    wrapped = []
    for frame in steps:
        wf = []
        for text, col in frame:
            while tmp.textlength(text, font=font) > 760 and len(text) > 40:
                text = text[: len(text) - 10] + "\u2026"
            wf.append((text, col))
            max_w = max(max_w, int(tmp.textlength(text, font=font)))
        wrapped.append(wf)
        max_lines = max(max_lines, len(wf))

    W = max_w + 48
    H = max_lines * 22 + 36
    frames, cum = [], []
    for wf in wrapped:
        cum = cum + wf
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        y = 18
        for text, col in cum:
            d.text((24, y), text, font=font, fill=col)
            y += 22
        frames.append(img)

    durs = list(DURATIONS)
    while len(durs) < len(frames):
        durs.append(700)
    durs = durs[: len(frames)]

    ASSETS.mkdir(parents=True, exist_ok=True)
    gif = ASSETS / "demo.gif"
    frames[0].save(gif, save_all=True, append_images=frames[1:], duration=durs,
                   loop=0, palette=Image.ADAPTIVE, colors=200, optimize=True)
    frames[0].save(ASSETS / "demo.png")
    print("gif ok", len(frames), "frames", gif.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
