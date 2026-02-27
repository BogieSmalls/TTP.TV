"""Sweep grid dx values to find correct NES tile alignment for MFmerks."""
import sys, os, subprocess
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from detector.digit_reader import DigitReader

CROP = {"x": 383, "y": 24, "w": 871, "h": 670}
STREAM_W, STREAM_H = 1280, 720
VOD_URL = "https://www.twitch.tv/videos/2705396017"
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates", "digits")

# Known ground truth from screenshots
GROUND_TRUTH = {
    600:  {"rup": 17,  "key": 0, "bmb": 4},
    1500: {"rup": 135, "key": 3, "bmb": 9},
    2400: {"rup": 255, "key": 6, "bmb": 9},
}

# dy=6 is confirmed correct (all landmark y%8 == 6)
DY = 6

# NES HUD layout: rupee icon at col 11, digits at cols 12-14
# Keys/Bombs digits at cols 13-14 (same as rupee tens/ones)
# Rupees row: (22-dy)//8 = (22-6)//8 = 2
# Keys row: (38-6)//8 = 4
# Bombs row: (46-6)//8 = 5
RUP_ROW = 2
KEY_ROW = 4
BMB_ROW = 5
RUP_COLS = [12, 13, 14]  # hundreds, tens, ones
KB_COLS = [13, 14]        # tens, ones


def extract_stream(sf, crop_x, crop_y, crop_w, crop_h, nes_x, nes_y, w=8, h=8):
    """Extract tile at NES coords from stream frame."""
    scale_x = crop_w / 256.0
    scale_y = crop_h / 240.0
    sx = crop_x + nes_x * scale_x
    sy = crop_y + nes_y * scale_y
    sw = w * scale_x
    sh = h * scale_y
    sx1, sy1 = int(round(sx)), int(round(sy))
    sx2, sy2 = int(round(sx + sw)), int(round(sy + sh))
    sx1, sx2 = max(0, sx1), min(sf.shape[1], sx2)
    sy1, sy2 = max(0, sy1), min(sf.shape[0], sy2)
    if sy2 <= sy1 or sx2 <= sx1:
        return np.zeros((h, w, 3), dtype=np.uint8)
    region = sf[sy1:sy2, sx1:sx2]
    return cv2.resize(region, (w, h), interpolation=cv2.INTER_NEAREST)


def read_counter(sf, digit_reader, cols, row, dx, dy):
    cx, cy, cw, ch = CROP["x"], CROP["y"], CROP["w"], CROP["h"]
    digits = []
    for col in cols:
        nes_x = col * 8 + dx
        nes_y = row * 8 + dy
        tile = extract_stream(sf, cx, cy, cw, ch, nes_x, nes_y)
        gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
        if np.mean(gray) < 10:
            continue
        d = digit_reader.read_digit(tile)
        if d is not None:
            digits.append(d)
    if not digits:
        return 0
    return int(''.join(str(d) for d in digits))


def main():
    digit_reader = DigitReader(TEMPLATE_DIR)
    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    frames = {}
    for ts in GROUND_TRUTH:
        cmd = [
            "ffmpeg", "-ss", str(ts), "-i", stream_url,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-v", "error", "pipe:1"
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if len(proc.stdout) == STREAM_W * STREAM_H * 3:
            frames[ts] = np.frombuffer(proc.stdout, dtype=np.uint8).reshape((STREAM_H, STREAM_W, 3))

    print(f"Testing dx=0..7 with dy={DY}")
    print(f"Ground truth: {GROUND_TRUTH}")
    print()

    for dx in range(8):
        total_correct = 0
        total_tests = 0
        details = []
        for ts, gt in GROUND_TRUTH.items():
            if ts not in frames:
                continue
            sf = frames[ts]
            rup = read_counter(sf, digit_reader, RUP_COLS, RUP_ROW, dx, DY)
            key = read_counter(sf, digit_reader, KB_COLS, KEY_ROW, dx, DY)
            bmb = read_counter(sf, digit_reader, KB_COLS, BMB_ROW, dx, DY)
            if rup > 255:
                rup = rup % 100
            rc = int(rup == gt["rup"])
            kc = int(key == gt["key"])
            bc = int(bmb == gt["bmb"])
            total_correct += rc + kc + bc
            total_tests += 3
            details.append(f"t={ts}: r={rup}{'OK' if rc else 'X'} k={key}{'OK' if kc else 'X'} b={bmb}{'OK' if bc else 'X'}")
        print(f"dx={dx}: {total_correct}/{total_tests} correct")
        for d in details:
            print(f"  {d}")
        print()


if __name__ == "__main__":
    main()
