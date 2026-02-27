"""Debug: compare tile-based vs strip-based extraction at exact positions."""
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
    print(f"Grid offset: dx={hud.grid_dx}, dy={hud.grid_dy}")

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    outdir = "debug_strip2"
    os.makedirs(outdir, exist_ok=True)

    for ts in [600]:
        cmd = [
            "ffmpeg", "-ss", str(ts), "-i", stream_url,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-v", "error", "pipe:1"
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if len(proc.stdout) != STREAM_W * STREAM_H * 3:
            print(f"t={ts}: SKIP ({len(proc.stdout)} bytes)")
            continue

        sf = np.frombuffer(proc.stdout, dtype=np.uint8).reshape((STREAM_H, STREAM_W, 3))
        x, y, w, h = CROP["x"], CROP["y"], CROP["w"], CROP["h"]
        canonical = cv2.resize(sf[y:y+h, x:x+w], (256, 240), interpolation=cv2.INTER_NEAREST)

        # Save the full HUD area zoomed
        hud_zoomed = cv2.resize(canonical[0:64, 80:128], (384, 512),
                                interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(f"{outdir}/t{ts}_hud_counters_zoom.png", hud_zoomed)

        # Method 1: Old tile-based extraction (for ground truth comparison)
        print(f"\n=== t={ts}s ===")
        print("\n--- Method 1: Individual tile extraction (stream source) ---")
        hud.set_stream_source(sf, x, y, w, h)
        # Rupees tiles at cols 12,13,14, row 2
        rup_cols = hud.RUPEE_DIGIT_COLS
        rup_row = hud.RUPEE_DIGIT_ROW
        for i, col in enumerate(rup_cols):
            tile = hud._tile(canonical, col, rup_row)
            d = digit_reader.read_digit(tile)
            gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
            print(f"  Rupee tile[{i}] col={col} row={rup_row}: digit={d}, brightness={np.mean(gray):.1f}")
            big = cv2.resize(tile, (64, 64), interpolation=cv2.INTER_NEAREST)
            cv2.imwrite(f"{outdir}/t{ts}_tile_rup{i}_d{d}.png", big)
        # Keys
        for i, col in enumerate(hud.KEY_DIGIT_COLS):
            tile = hud._tile(canonical, col, hud.KEY_DIGIT_ROW)
            d = digit_reader.read_digit(tile)
            gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
            print(f"  Key tile[{i}] col={col} row={hud.KEY_DIGIT_ROW}: digit={d}, brightness={np.mean(gray):.1f}")
        # Bombs
        for i, col in enumerate(hud.BOMB_DIGIT_COLS):
            tile = hud._tile(canonical, col, hud.BOMB_DIGIT_ROW)
            d = digit_reader.read_digit(tile)
            gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
            print(f"  Bomb tile[{i}] col={col} row={hud.BOMB_DIGIT_ROW}: digit={d}, brightness={np.mean(gray):.1f}")

        # Method 2: Strip extraction
        print("\n--- Method 2: Strip extraction (stream source) ---")
        for name, lm, nd in [("rup", hud._rupee_lm, 3), ("key", hud._key_lm, 2), ("bmb", hud._bomb_lm, 2)]:
            total_chars = max(nd + 1, round(lm['w'] / 8))
            norm_w = total_chars * 8
            center_x = lm['x'] + lm['w'] / 2
            start_x = int(round(center_x - norm_w / 2))

            strip = hud._extract(canonical, start_x, lm['y'], norm_w, 8)
            strip_gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)

            # Save strip zoomed
            big_strip = cv2.resize(strip, (norm_w * 8, 64), interpolation=cv2.INTER_NEAREST)
            cv2.imwrite(f"{outdir}/t{ts}_strip_{name}.png", big_strip)

            digit_start = total_chars - nd
            for i in range(total_chars):
                tile_from_strip = strip[0:8, i*8:(i+1)*8]
                d = digit_reader.read_digit(tile_from_strip)
                bright = float(np.mean(tile_from_strip))
                is_digit_pos = (i >= digit_start)
                marker = " <-- DIGIT" if is_digit_pos else ""
                print(f"  {name} char[{i}] x={i*8}: digit={d}, brightness={bright:.1f}{marker}")
                big = cv2.resize(tile_from_strip, (64, 64), interpolation=cv2.INTER_NEAREST)
                cv2.imwrite(f"{outdir}/t{ts}_strip_{name}_char{i}_d{d}.png", big)

        hud.clear_stream_source()

        # Method 3: read_digit on the exact same strip positions (canonical)
        print("\n--- Method 3: Strip extraction (canonical only) ---")
        for name, lm, nd in [("rup", hud._rupee_lm, 3), ("key", hud._key_lm, 2), ("bmb", hud._bomb_lm, 2)]:
            total_chars = max(nd + 1, round(lm['w'] / 8))
            norm_w = total_chars * 8
            center_x = lm['x'] + lm['w'] / 2
            start_x = int(round(center_x - norm_w / 2))

            strip = hud._extract(canonical, start_x, lm['y'], norm_w, 8)
            strip_gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)

            digit_start = total_chars - nd
            for i in range(total_chars):
                tile_from_strip = strip[0:8, i*8:(i+1)*8]
                d = digit_reader.read_digit(tile_from_strip)
                bright = float(np.mean(tile_from_strip))
                is_digit_pos = (i >= digit_start)
                marker = " <-- DIGIT" if is_digit_pos else ""
                print(f"  {name} char[{i}] x={i*8}: digit={d}, brightness={bright:.1f}{marker}")


if __name__ == "__main__":
    main()
