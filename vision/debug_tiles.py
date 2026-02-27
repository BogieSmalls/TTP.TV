"""Debug: extract tiles at computed positions and save for visual inspection."""
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
    print(f"RUPEE_DIGIT_COLS={hud.RUPEE_DIGIT_COLS}, ROW={hud.RUPEE_DIGIT_ROW}")
    print(f"KEY_DIGIT_COLS={hud.KEY_DIGIT_COLS}, ROW={hud.KEY_DIGIT_ROW}")
    print(f"BOMB_DIGIT_COLS={hud.BOMB_DIGIT_COLS}, ROW={hud.BOMB_DIGIT_ROW}")
    print(f"SWORD_COL={hud.SWORD_COL}, ROW={hud.SWORD_ROW}")
    print(f"LEVEL_DIGIT_COL={hud.LEVEL_DIGIT_COL}, ROW={hud.LEVEL_DIGIT_ROW}")

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    outdir = "debug_tiles"
    os.makedirs(outdir, exist_ok=True)

    for ts in [600, 1500]:
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

        hud.set_stream_source(sf, x, y, w, h)

        print(f"\n=== t={ts} ===")

        # Save the full HUD area with grid overlay
        hud_area = canonical[0:64, :].copy()
        big = cv2.resize(hud_area, (256*4, 64*4), interpolation=cv2.INTER_NEAREST)
        # Draw grid lines
        for col in range(32):
            gx = (col * 8 + hud.grid_dx) * 4
            if 0 <= gx < big.shape[1]:
                big[:, gx, :] = [0, 128, 0]  # green vertical lines
        for row in range(8):
            gy = (row * 8 + hud.grid_dy) * 4
            if 0 <= gy < big.shape[0]:
                big[gy, :, :] = [0, 128, 0]  # green horizontal lines
        cv2.imwrite(f"{outdir}/t{ts}_hud_grid.png", big)

        # Extract and save each counter digit tile
        for name, cols, row in [
            ("rup", hud.RUPEE_DIGIT_COLS, hud.RUPEE_DIGIT_ROW),
            ("key", hud.KEY_DIGIT_COLS, hud.KEY_DIGIT_ROW),
            ("bmb", hud.BOMB_DIGIT_COLS, hud.BOMB_DIGIT_ROW),
        ]:
            print(f"  {name}: cols={cols}, row={row}")
            for i, col in enumerate(cols):
                tile = hud._tile(canonical, col, row)
                # Save tile at 8x zoom
                big_tile = cv2.resize(tile, (64, 64), interpolation=cv2.INTER_NEAREST)
                nes_x = col * 8 + hud.grid_dx
                nes_y = row * 8 + hud.grid_dy
                cv2.imwrite(f"{outdir}/t{ts}_{name}_c{col}r{row}.png", big_tile)

                # Template match
                gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
                mean_val = float(np.mean(gray))
                d = digit_reader.read_digit(tile)
                # Get best match score
                best_score = 0.0
                best_d = None
                for digit, tmpl in digit_reader.template_grays.items():
                    result = cv2.matchTemplate(gray, tmpl, cv2.TM_CCOEFF_NORMED)
                    score = float(result[0][0])
                    if score > best_score:
                        best_score = score
                        best_d = digit
                print(f"    col={col}: nes({nes_x},{nes_y}) mean={mean_val:.1f} "
                      f"best_match={best_d}@{best_score:.3f} read={d}")

        # Also extract tiles at shifted positions to see what's nearby
        print(f"  --- rupee area scan (row={hud.RUPEE_DIGIT_ROW}) ---")
        for col in range(10, 16):
            tile = hud._tile(canonical, col, hud.RUPEE_DIGIT_ROW)
            gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
            mean_val = float(np.mean(gray))
            d = digit_reader.read_digit(tile)
            best_score = 0.0
            best_d = None
            for digit, tmpl in digit_reader.template_grays.items():
                result = cv2.matchTemplate(gray, tmpl, cv2.TM_CCOEFF_NORMED)
                score = float(result[0][0])
                if score > best_score:
                    best_score = score
                    best_d = digit
            nes_x = col * 8 + hud.grid_dx
            flag = " <-- digit col" if col in hud.RUPEE_DIGIT_COLS else ""
            print(f"    col={col} x={nes_x}: mean={mean_val:.1f} "
                  f"best={best_d}@{best_score:.3f} read={d}{flag}")
            big_tile = cv2.resize(tile, (64, 64), interpolation=cv2.INTER_NEAREST)
            cv2.imwrite(f"{outdir}/t{ts}_scan_c{col}r{hud.RUPEE_DIGIT_ROW}.png", big_tile)

        # Also try with different dx values to find alignment
        print(f"  --- dx sweep for rupee ones (expected col14, row={hud.RUPEE_DIGIT_ROW}) ---")
        for dx_test in range(8):
            nes_x = 14 * 8 + dx_test
            nes_y = hud.RUPEE_DIGIT_ROW * 8 + hud.grid_dy
            tile = hud._extract(canonical, nes_x, nes_y, 8, 8)
            d = digit_reader.read_digit(tile)
            best_score = 0.0
            best_d = None
            gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
            for digit, tmpl in digit_reader.template_grays.items():
                result = cv2.matchTemplate(gray, tmpl, cv2.TM_CCOEFF_NORMED)
                score = float(result[0][0])
                if score > best_score:
                    best_score = score
                    best_d = digit
            print(f"    dx={dx_test}: x={nes_x} best={best_d}@{best_score:.3f} read={d}")

        hud.clear_stream_source()


if __name__ == "__main__":
    main()
