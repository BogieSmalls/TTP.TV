"""Sweep dx values to find best digit template match alignment."""
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

# Expected values: t=600 Rup=17, t=1500 Rup=135
# Test rupee ones digit specifically (most diagnostic)


def main():
    digit_reader = DigitReader(TEMPLATE_DIR)

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    outdir = "debug_dx"
    os.makedirs(outdir, exist_ok=True)

    for ts in [600, 1500]:
        cmd = [
            "ffmpeg", "-ss", str(ts), "-i", stream_url,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-v", "error", "pipe:1"
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if len(proc.stdout) != STREAM_W * STREAM_H * 3:
            continue

        sf = np.frombuffer(proc.stdout, dtype=np.uint8).reshape((STREAM_H, STREAM_W, 3))
        x, y, w, h = CROP["x"], CROP["y"], CROP["w"], CROP["h"]

        print(f"\n=== t={ts} ===")

        # Try every dx/dy combination, extracting specific known digits
        # Rupee digits at cols 12,13,14 with dy=6 (from landmarks)
        dy = 6

        # Also try different row assignments
        # Standard: rup=2, key=3, bmb=4
        # Landmark-derived: rup=2, key=4, bmb=5
        for rup_row, key_row, bmb_row, label in [
            (2, 4, 5, "landmark-rows"),
        ]:
            print(f"\n  {label} (rup_row={rup_row}, key_row={key_row}, bmb_row={bmb_row}):")
            for dx in range(8):
                for dy_test in range(max(0, dy - 2), min(8, dy + 3)):
                    # Create a minimal HudReader with specific offset
                    hud = HudReader(grid_offset=(dx, dy_test))
                    hud.set_stream_source(sf, x, y, w, h)

                    # Read rupee digits
                    rup_digits = []
                    rup_scores = []
                    for col in [12, 13, 14]:
                        tile = hud._tile(sf, col, rup_row)
                        gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
                        mean_val = float(np.mean(gray))
                        if mean_val < 10:
                            rup_digits.append(None)
                            rup_scores.append(0)
                            continue
                        best_score = 0.0
                        best_d = None
                        for d, tmpl in digit_reader.template_grays.items():
                            r = cv2.matchTemplate(gray, tmpl, cv2.TM_CCOEFF_NORMED)
                            s = float(r[0][0])
                            if s > best_score:
                                best_score = s
                                best_d = d
                        rup_digits.append(best_d)
                        rup_scores.append(best_score)

                    # Read key digit
                    key_tile = hud._tile(sf, 14, key_row)
                    key_gray = cv2.cvtColor(key_tile, cv2.COLOR_BGR2GRAY)
                    key_d = digit_reader.read_digit(key_tile)
                    key_mean = float(np.mean(key_gray))

                    # Read bomb digit
                    bmb_tile = hud._tile(sf, 14, bmb_row)
                    bmb_gray = cv2.cvtColor(bmb_tile, cv2.COLOR_BGR2GRAY)
                    bmb_d = digit_reader.read_digit(bmb_tile)
                    bmb_mean = float(np.mean(bmb_gray))

                    # Build rupee value
                    rd = [d for d in rup_digits if d is not None]
                    rup_val = int(''.join(str(d) for d in rd)) if rd else 0
                    avg_score = np.mean([s for s in rup_scores if s > 0]) if any(s > 0 for s in rup_scores) else 0

                    # Score against expected
                    if ts == 600:
                        exp_rup, exp_key, exp_bmb = 17, 0, 4
                    else:
                        exp_rup, exp_key, exp_bmb = 135, 3, 9

                    score = 0
                    if rup_val == exp_rup: score += 3
                    elif rup_val % 100 == exp_rup % 100: score += 2
                    if key_d == exp_key or (key_mean < 10 and exp_key == 0): score += 2
                    if bmb_d == exp_bmb: score += 2

                    if score > 2 or avg_score > 0.4:
                        print(f"    dx={dx} dy={dy_test}: rup={rup_val} "
                              f"(digits={rup_digits}, scores=[{','.join(f'{s:.2f}' for s in rup_scores)}]) "
                              f"key={key_d}(m={key_mean:.0f}) bmb={bmb_d}(m={bmb_mean:.0f}) "
                              f"score={score} avg_match={avg_score:.3f}")

                    # Save tiles for the best candidates
                    if score >= 4:
                        for i, col in enumerate([12, 13, 14]):
                            tile = hud._tile(sf, col, rup_row)
                            big = cv2.resize(tile, (64, 64), interpolation=cv2.INTER_NEAREST)
                            cv2.imwrite(f"{outdir}/t{ts}_dx{dx}dy{dy_test}_c{col}.png", big)

                    hud.clear_stream_source()


if __name__ == "__main__":
    main()
