"""Debug script to find correct game_bbox for blessedbe_ frames."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import cv2
import numpy as np
from detector.auto_crop import find_grid_alignment
from detector.hud_reader import HudReader
from detector.digit_reader import DigitReader
from detector.nes_frame import NESFrame

FRAMES_DIR = r"D:\Projects\Streaming\TTPRestream\data\extracted-frames\silly-rock-8631-v2"
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates")


def make_canonical(frame, cx, cy, cw, ch):
    fh, fw = frame.shape[:2]
    sy1, sy2 = max(0, cy), min(fh, cy + ch)
    sx1, sx2 = max(0, cx), min(fw, cx + cw)
    region = np.zeros((ch, cw, 3), dtype=np.uint8)
    if sy2 > sy1 and sx2 > sx1:
        region[(sy1 - cy):(sy1 - cy) + (sy2 - sy1),
               (sx1 - cx):(sx1 - cx) + (sx2 - sx1)] = frame[sy1:sy2, sx1:sx2]
    return cv2.resize(region, (256, 240), interpolation=cv2.INTER_AREA)


def read_counters(canonical, dx, dy, life_row):
    dr = DigitReader(f"{TEMPLATE_DIR}/digits")
    hud = HudReader(life_row=life_row)
    nf = NESFrame(canonical, 1.0, 1.0, grid_dx=dx, grid_dy=dy)
    rupees = hud.read_rupees(nf, dr)
    keys_count, _ = hud.read_keys(nf, dr)
    bombs = hud.read_bombs(nf, dr)
    return rupees, keys_count, bombs


def scan_all_cx(img_path, target_rupees, target_keys, target_bombs):
    """Full scan: all cx values for the given frame."""
    frame = cv2.imread(str(img_path))
    fh, fw = frame.shape[:2]
    print(f"Frame: {fw}x{fh}")

    hits = []
    best_partial = []

    # From the red pixel analysis: LIFE text at x≈1100-1150, y≈82-188
    # Estimated game: cx≈630-680, cw≈640-750, cy≈0, ch≈600-720
    # Try cw range that matches 256:240 aspect ratio
    for cw in range(600, 900, 4):
        ch = round(cw * 240 / 256)
        if ch > fh:
            continue
        # Try cy=0 and cy offsets
        for cy in [0, -20, -10, 10, 20]:
            # Scan cx across full width
            for cx in range(400, fw - cw + 1, 4):
                canonical = make_canonical(frame, cx, cy, cw, ch)
                result = find_grid_alignment(canonical)
                if result is None:
                    continue
                dx, dy, life_row = result
                try:
                    rupees, keys, bombs = read_counters(canonical, dx, dy, life_row)
                except Exception:
                    continue

                score = (rupees == target_rupees) + (keys == target_keys) + (bombs == target_bombs)
                if score == 3:
                    hits.append((cx, cy, cw, ch, dx, dy, life_row, rupees, keys, bombs))
                    print(f"  HIT: cx={cx} cy={cy} cw={cw} ch={ch} dx={dx} dy={dy} life_row={life_row} "
                          f"R={rupees} K={keys} B={bombs}")
                elif score >= 2:
                    best_partial.append((score, cx, cy, cw, ch, dx, dy, life_row, rupees, keys, bombs))

    if not hits:
        print("No exact hits. Best partial (2/3) results:")
        best_partial.sort(reverse=True)
        for item in best_partial[:20]:
            score, cx, cy, cw, ch, dx, dy, life_row, rupees, keys, bombs = item
            r_mark = 'R' if rupees == target_rupees else f'r={rupees}'
            k_mark = 'K' if keys == target_keys else f'k={keys}'
            b_mark = 'B' if bombs == target_bombs else f'b={bombs}'
            print(f"  cx={cx} cy={cy} cw={cw} ch={ch} dx={dx} dy={dy} lr={life_row} "
                  f"{r_mark} {k_mark} {b_mark}")
    return hits


img = os.path.join(FRAMES_DIR, "blessedbe_", "mid_30m00s_f003.jpg")
print("=== blessedbe_/mid ===")
print("Target: R=70, K=3, B=5")
hits = scan_all_cx(img, 70, 3, 5)
