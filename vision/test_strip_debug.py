"""Debug: visualize what the strip-based counter reading extracts."""
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


def debug_strip(nf, digit_reader, lm, num_digits, name, ts, outdir):
    """Extract and visualize a counter strip."""
    total_chars = max(num_digits + 1, round(lm['w'] / 8))
    norm_w = total_chars * 8
    center_x = lm['x'] + lm['w'] / 2
    start_x = int(round(center_x - norm_w / 2))

    raw = nf.extract(start_x, lm['y'], norm_w, 8)
    gray = cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)

    # Save strip (zoomed 8x)
    big = cv2.resize(raw, (norm_w * 8, 64), interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(f"{outdir}/t{ts}_{name}_strip.png", big)

    # Save grayscale strip
    big_gray = cv2.resize(gray, (norm_w * 8, 64), interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(f"{outdir}/t{ts}_{name}_strip_gray.png", big_gray)

    digit_start = total_chars - num_digits
    score_len = norm_w - 8 + 1

    print(f"  {name}: total_chars={total_chars}, norm_w={norm_w}, start_x={start_x}, digit_start={digit_start}")
    print(f"  {name}: strip gray stats: min={gray.min()}, max={gray.max()}, mean={gray.mean():.1f}")

    # Template match for each digit
    for digit, tmpl in digit_reader.template_grays.items():
        result = cv2.matchTemplate(gray, tmpl, cv2.TM_CCOEFF_NORMED)
        scores = result[0]
        best_x = int(np.argmax(scores))
        best_score = float(scores[best_x])
        if best_score > 0.3:
            print(f"  {name}: digit {digit} best score={best_score:.3f} at x={best_x}")

    # Per-position analysis
    for i in range(num_digits):
        expected_x = (digit_start + i) * 8
        search_lo = max(0, expected_x - 3)
        search_hi = min(score_len - 1, expected_x + 3)

        best_score = 0.0
        best_digit = None
        best_x = expected_x
        for digit, tmpl in digit_reader.template_grays.items():
            result = cv2.matchTemplate(gray, tmpl, cv2.TM_CCOEFF_NORMED)
            scores = result[0]
            for x in range(search_lo, search_hi + 1):
                if scores[x] > best_score:
                    best_score = scores[x]
                    best_digit = digit
                    best_x = x
        print(f"  {name} pos[{i}]: expected_x={expected_x}, best={best_digit}@x={best_x} score={best_score:.3f}")

        # Save the tile at best match position
        if best_x + 8 <= norm_w:
            tile = raw[0:8, best_x:best_x+8]
            big_tile = cv2.resize(tile, (64, 64), interpolation=cv2.INTER_NEAREST)
            cv2.imwrite(f"{outdir}/t{ts}_{name}_pos{i}_d{best_digit}.png", big_tile)


def main():
    digit_reader = DigitReader(TEMPLATE_DIR)
    hud = HudReader(landmarks=LANDMARKS)

    # Look up landmark dicts directly
    _rupee_lm = next(l for l in LANDMARKS if l['label'] == 'Rupees')
    _key_lm = next(l for l in LANDMARKS if l['label'] == 'Keys')
    _bomb_lm = next(l for l in LANDMARKS if l['label'] == 'Bombs')

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    outdir = "debug_strip"
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

        # Save full HUD area
        hud_area = canonical[0:64, :]
        big_hud = cv2.resize(hud_area, (hud_area.shape[1]*4, hud_area.shape[0]*4), interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(f"{outdir}/t{ts}_hud.png", big_hud)

        print(f"\n=== t={ts}s (stream source) ===")
        nf = NESFrame(extract_nes_crop(sf, x, y, w, h),
                      w / 256.0, h / 240.0)
        for name, lm, nd in [("rup", _rupee_lm, 3), ("key", _key_lm, 2), ("bmb", _bomb_lm, 2)]:
            debug_strip(nf, digit_reader, lm, nd, name, ts, outdir)

        # Also read with the actual methods
        rup = hud.read_rupees(nf, digit_reader)
        key_count, master = hud.read_keys(nf, digit_reader)
        bmb = hud.read_bombs(nf, digit_reader)
        print(f"  RESULT: rup={rup}, key={key_count}, bmb={bmb}")

        print(f"\n=== t={ts}s (canonical only) ===")
        nf_canon = NESFrame(canonical, 1.0, 1.0)
        for name, lm, nd in [("rup", _rupee_lm, 3), ("key", _key_lm, 2), ("bmb", _bomb_lm, 2)]:
            debug_strip(nf_canon, digit_reader, lm, nd, f"{name}_c", ts, outdir)


if __name__ == "__main__":
    main()
