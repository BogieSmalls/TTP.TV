"""Debug: save the actual tiles the detector extracts for digit reading."""
import sys, os, subprocess
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from detector.hud_reader import HudReader
from detector.digit_reader import DigitReader

CROP = {"x": 383, "y": 24, "w": 871, "h": 670}
STREAM_W, STREAM_H = 1280, 720
LANDMARKS = [
    {"label": "-LIFE-", "x": 184, "y": 23, "w": 46, "h": 8},
    {"label": "Hearts", "x": 176, "y": 38, "w": 65, "h": 18},
    {"label": "Rupees", "x": 87, "y": 22, "w": 33, "h": 8},
    {"label": "Keys", "x": 87, "y": 38, "w": 33, "h": 8},
    {"label": "Bombs", "x": 87, "y": 46, "w": 33, "h": 8},
    {"label": "B", "x": 123, "y": 22, "w": 18, "h": 32},
    {"label": "A", "x": 147, "y": 22, "w": 18, "h": 32},
    {"label": "Minimap", "x": 16, "y": 23, "w": 65, "h": 32},
    {"label": "LVL", "x": 16, "y": 14, "w": 65, "h": 9},
]
VOD_URL = "https://www.twitch.tv/videos/2705396017"
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates", "digits")


def main():
    digit_reader = DigitReader(TEMPLATE_DIR)
    hud = HudReader(grid_offset=(0, 0), landmarks=LANDMARKS)

    # Show computed pixel positions
    print(f"Grid offset: dx={hud.grid_dx}, dy={hud.grid_dy}")
    if hasattr(hud, '_rupee_digit_px'):
        print(f"Rupee digit px: {hud._rupee_digit_px}")
    if hasattr(hud, '_key_digit_px'):
        print(f"Key digit px: {hud._key_digit_px}")
    if hasattr(hud, '_bomb_digit_px'):
        print(f"Bomb digit px: {hud._bomb_digit_px}")

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    os.makedirs("debug_tiles2", exist_ok=True)

    for ts in [600, 1500, 2400]:
        cmd = [
            "ffmpeg", "-ss", str(ts), "-i", stream_url,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-v", "error", "pipe:1"
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if len(proc.stdout) != STREAM_W * STREAM_H * 3:
            print(f"t={ts}: SKIP")
            continue

        sf = np.frombuffer(proc.stdout, dtype=np.uint8).reshape((STREAM_H, STREAM_W, 3))
        x, y, w, h = CROP["x"], CROP["y"], CROP["w"], CROP["h"]
        canonical = cv2.resize(sf[y:y+h, x:x+w], (256, 240), interpolation=cv2.INTER_NEAREST)

        # Save canonical frame with pixel position markers
        marked = canonical.copy()
        if hasattr(hud, '_rupee_digit_px'):
            for i, (px, py) in enumerate(hud._rupee_digit_px):
                cv2.rectangle(marked, (px, py), (px+8, py+8), (0, 255, 0), 1)
                cv2.putText(marked, f"R{i}", (px, py-2), cv2.FONT_HERSHEY_SIMPLEX, 0.25, (0, 255, 0), 1)
        if hasattr(hud, '_key_digit_px'):
            for i, (px, py) in enumerate(hud._key_digit_px):
                cv2.rectangle(marked, (px, py), (px+8, py+8), (255, 255, 0), 1)
                cv2.putText(marked, f"K{i}", (px, py-2), cv2.FONT_HERSHEY_SIMPLEX, 0.25, (255, 255, 0), 1)
        if hasattr(hud, '_bomb_digit_px'):
            for i, (px, py) in enumerate(hud._bomb_digit_px):
                cv2.rectangle(marked, (px, py), (px+8, py+8), (0, 255, 255), 1)
                cv2.putText(marked, f"B{i}", (px, py-2), cv2.FONT_HERSHEY_SIMPLEX, 0.25, (0, 255, 255), 1)
        cv2.imwrite(f"debug_tiles2/t{ts}_canonical_marked.png", marked)

        # Save HUD area zoomed
        hud_area = canonical[0:64, 80:170]
        big_hud = cv2.resize(hud_area, (hud_area.shape[1]*4, hud_area.shape[0]*4), interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(f"debug_tiles2/t{ts}_hud_zoom.png", big_hud)

        # Extract tiles with stream source
        hud.set_stream_source(sf, x, y, w, h)
        print(f"\n=== t={ts}s (stream extraction) ===")
        for name, positions in [("rup", getattr(hud, '_rupee_digit_px', [])),
                                 ("key", getattr(hud, '_key_digit_px', [])),
                                 ("bmb", getattr(hud, '_bomb_digit_px', []))]:
            for i, (px, py) in enumerate(positions):
                tile = hud._extract(canonical, px, py, 8, 8)
                gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
                d = digit_reader.read_digit(tile)
                mean_b = float(np.mean(gray))
                big = cv2.resize(tile, (64, 64), interpolation=cv2.INTER_NEAREST)
                cv2.imwrite(f"debug_tiles2/t{ts}_stream_{name}{i}_d{d}_b{mean_b:.0f}.png", big)
                print(f"  {name}[{i}] px=({px},{py}) -> digit={d}, brightness={mean_b:.1f}")

        # Extract tiles WITHOUT stream source (canonical only)
        hud.clear_stream_source()
        print(f"=== t={ts}s (canonical only) ===")
        for name, positions in [("rup", getattr(hud, '_rupee_digit_px', [])),
                                 ("key", getattr(hud, '_key_digit_px', [])),
                                 ("bmb", getattr(hud, '_bomb_digit_px', []))]:
            for i, (px, py) in enumerate(positions):
                tile = hud._extract(canonical, px, py, 8, 8)
                gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
                d = digit_reader.read_digit(tile)
                mean_b = float(np.mean(gray))
                big = cv2.resize(tile, (64, 64), interpolation=cv2.INTER_NEAREST)
                cv2.imwrite(f"debug_tiles2/t{ts}_canon_{name}{i}_d{d}_b{mean_b:.0f}.png", big)
                print(f"  {name}[{i}] px=({px},{py}) -> digit={d}, brightness={mean_b:.1f}")

        hud.clear_stream_source()


if __name__ == "__main__":
    main()
