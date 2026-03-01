"""Debug: compare template matching approaches on extracted tiles."""
import sys, os, subprocess
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from detector.hud_reader import HudReader
from detector.digit_reader import DigitReader
from detector.nes_frame import NESFrame, extract_nes_crop

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


def match_binarized(tile_gray, tmpl_gray):
    """Match using binarized XOR (pixel mismatch count)."""
    _, tile_bin = cv2.threshold(tile_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, tmpl_bin = cv2.threshold(tmpl_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    xor = cv2.bitwise_xor(tile_bin, tmpl_bin)
    mismatches = np.sum(xor > 0)
    return 1.0 - mismatches / 64.0  # 64 pixels total


def match_binary_corr(tile_gray, tmpl_gray):
    """Match using correlation on binarized images."""
    _, tile_bin = cv2.threshold(tile_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, tmpl_bin = cv2.threshold(tmpl_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    result = cv2.matchTemplate(tile_bin, tmpl_bin, cv2.TM_CCOEFF_NORMED)
    return float(result[0][0])


def main():
    digit_reader = DigitReader(TEMPLATE_DIR)
    hud = HudReader(landmarks=LANDMARKS)

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    outdir = "debug_match"
    os.makedirs(outdir, exist_ok=True)

    expected = {
        600: {"rup": (1, 7), "key": (0,), "bmb": (4,)},
        1500: {"rup": (1, 3, 5), "key": (3,), "bmb": (9,)},
    }

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
        nes_region = extract_nes_crop(sf, x, y, w, h)
        nf = NESFrame(nes_region, w / 256.0, h / 240.0, grid_dx=0, grid_dy=0)
        canonical = nf.to_canonical()

        print(f"\n=== t={ts} ===")

        for name, cols, row, exp_digits in [
            ("rup", hud.RUPEE_DIGIT_COLS, hud.RUPEE_DIGIT_ROW, expected[ts]["rup"]),
            ("key", hud.KEY_DIGIT_COLS, hud.KEY_DIGIT_ROW, expected[ts]["key"]),
            ("bmb", hud.BOMB_DIGIT_COLS, hud.BOMB_DIGIT_ROW, expected[ts]["bmb"]),
        ]:
            # Only check last N digits where N = len(exp_digits)
            check_cols = cols[-len(exp_digits):]
            for col, exp_d in zip(check_cols, exp_digits):
                tile = nf.tile(col, row)
                gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)

                # Save side-by-side comparison (tile vs expected template)
                tmpl = digit_reader.template_grays.get(exp_d)
                if tmpl is not None:
                    # Make comparison image: tile | template | diff
                    _, tile_bin = cv2.threshold(gray, 0, 255,
                                                cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                    _, tmpl_bin = cv2.threshold(tmpl, 0, 255,
                                                cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                    diff = cv2.bitwise_xor(tile_bin, tmpl_bin)
                    comp = np.hstack([gray, tmpl, tile_bin, tmpl_bin, diff])
                    big = cv2.resize(comp, (comp.shape[1]*8, 64),
                                     interpolation=cv2.INTER_NEAREST)
                    cv2.imwrite(f"{outdir}/t{ts}_{name}_c{col}_exp{exp_d}.png", big)

                # Test all matching methods
                print(f"  {name} col={col} expected={exp_d}:")

                for d in range(10):
                    t_gray = digit_reader.template_grays.get(d)
                    if t_gray is None:
                        continue
                    # Method 1: CCOEFF_NORMED (current)
                    r1 = cv2.matchTemplate(gray, t_gray, cv2.TM_CCOEFF_NORMED)
                    s1 = float(r1[0][0])
                    # Method 2: Binarized XOR
                    s2 = match_binarized(gray, t_gray)
                    # Method 3: Binary correlation
                    s3 = match_binary_corr(gray, t_gray)
                    marker = " <-- expected" if d == exp_d else ""
                    if s1 > 0.1 or s2 > 0.75 or d == exp_d:
                        print(f"    d={d}: ccoeff={s1:.3f} xor={s2:.3f} "
                              f"bin_corr={s3:.3f}{marker}")

        # nf goes out of scope at next iteration


if __name__ == "__main__":
    main()
