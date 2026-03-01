"""Test binary shape template matching for B-item detection.

Uses Bogie's saved stream frame (debug_full_1800s.png) where the B-item
is a blue candle. Previously misidentified as 'boomerang' by color heuristics.
"""
import cv2
import numpy as np

from detector.item_reader import ItemReader
from detector.hud_reader import HudReader
from detector.nes_frame import NESFrame, extract_nes_crop

# Bogie's crop profile
CROP_X, CROP_Y, CROP_W, CROP_H = 541, -31, 1379, 1111
LANDMARKS = [
    {'label': '-LIFE-', 'x': 186, 'y': 24, 'w': 40, 'h': 8},
    {'label': 'Hearts', 'x': 176, 'y': 38, 'w': 64, 'h': 16},
    {'label': 'Rupees', 'x': 87, 'y': 24, 'w': 32, 'h': 8},
    {'label': 'Keys', 'x': 87, 'y': 40, 'w': 24, 'h': 8},
    {'label': 'Bombs', 'x': 87, 'y': 48, 'w': 24, 'h': 8},
    {'label': 'B', 'x': 124, 'y': 24, 'w': 16, 'h': 16},
    {'label': 'A', 'x': 148, 'y': 24, 'w': 16, 'h': 16},
    {'label': 'Minimap', 'x': 16, 'y': 24, 'w': 64, 'h': 32},
    {'label': 'LVL', 'x': 16, 'y': 15, 'w': 80, 'h': 8},
]


def create_canonical(stream_frame):
    fh, fw = stream_frame.shape[:2]
    y1, y2 = CROP_Y, CROP_Y + CROP_H
    x1, x2 = CROP_X, CROP_X + CROP_W
    sy1, sy2 = max(0, y1), min(fh, y2)
    sx1, sx2 = max(0, x1), min(fw, x2)
    dy_off = sy1 - y1
    dx_off = sx1 - x1
    nes_region = np.zeros((CROP_H, CROP_W, 3), dtype=np.uint8)
    if sy2 > sy1 and sx2 > sx1:
        nes_region[dy_off:dy_off + (sy2 - sy1),
                   dx_off:dx_off + (sx2 - sx1)] = stream_frame[sy1:sy2, sx1:sx2]
    return cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)


def main():
    stream = cv2.imread('debug_full_1800s.png')
    if stream is None:
        print("ERROR: Cannot load debug_full_1800s.png")
        return
    print(f"Stream frame: {stream.shape[1]}x{stream.shape[0]}")

    canonical = create_canonical(stream)

    item_reader = ItemReader('templates/items')
    print(f"Item templates loaded: {len(item_reader.templates)}")
    print(f"Template size: {item_reader._tmpl_w}x{item_reader._tmpl_h}")

    hud = HudReader(landmarks=LANDMARKS)

    # --- Test with stream extraction (best quality) ---
    nf = NESFrame(extract_nes_crop(stream, CROP_X, CROP_Y, CROP_W, CROP_H),
                  CROP_W / 256.0, CROP_H / 240.0, grid_dx=2, grid_dy=0)

    y = hud.B_ITEM_Y + nf.grid_dy
    x = hud.B_ITEM_X + nf.grid_dx
    print(f"\nB-item extraction position: ({x}, {y})")

    # Extract the 16x24 region (same as read_b_item now uses)
    region = nf.extract(x, y, 16, 24)
    print(f"Region shape: {region.shape}, mean brightness: {np.mean(region):.1f}")

    # Show binary mask of the extracted region
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 10, 255, cv2.THRESH_BINARY)
    print(f"\nExtracted region binary mask ({region.shape[1]}x{region.shape[0]}):")
    for row in range(region.shape[0]):
        line = ''
        for col in range(region.shape[1]):
            line += '#' if mask[row, col] > 0 else '.'
        print(f"  {line}")

    # Score all templates
    scores = item_reader.read_item_scored(region)
    print(f"\nAll template scores (stream extraction, sliding 8x16 in 16x24):")
    for name, score in scores:
        marker = " <--- EXPECTED" if name == 'blue_candle' else ""
        print(f"  {name:25s}: {score:.4f}{marker}")

    result = item_reader.read_item(region)
    print(f"\nBest match: {result}")
    print(f"Expected:   blue_candle")

    # Full pipeline test
    print("\n=== Full pipeline (read_b_item) ===")
    result_full = hud.read_b_item(nf, item_reader)
    print(f"  Stream + template: {result_full}")

    nf_canon = NESFrame(canonical, 1.0, 1.0, grid_dx=2, grid_dy=0)
    result_canon = hud.read_b_item(nf_canon, item_reader)
    print(f"  Canon + template:  {result_canon}")

    result_heuristic = hud.read_b_item(nf_canon)
    print(f"  Canon + heuristic: {result_heuristic}")

    # Save debug images
    cv2.imwrite('debug_bitem_region_16x24.png',
                cv2.resize(region, (128, 192), interpolation=cv2.INTER_NEAREST))
    cv2.imwrite('debug_bitem_mask_16x24.png',
                cv2.resize(mask, (128, 192), interpolation=cv2.INTER_NEAREST))

    # Show the blue_candle template mask for comparison
    if 'blue_candle' in item_reader._template_masks:
        tmask = item_reader._template_masks['blue_candle']
        print(f"\nBlue candle template ({tmask.shape[1]}x{tmask.shape[0]}):")
        for row in range(tmask.shape[0]):
            line = ''
            for col in range(tmask.shape[1]):
                line += '#' if tmask[row, col] > 0 else '.'
            print(f"  {line}")


if __name__ == '__main__':
    main()
