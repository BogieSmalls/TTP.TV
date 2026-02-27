"""Explore feasibility of staircase item detection.

Loads screenshots of dungeon staircase rooms, identifies the NES game area,
extracts the region where items sit on the central platform, and attempts
template matching using existing ItemReader.

Also checks the "item hoisted" position (Link holding item above his head).

Findings (from BogieSmalls stream screenshots):
  - Pedestal item (resting): NES coords ~(136-140, 144-150), score 0.727 for red_ring
  - Hoisted item (above Link): NES coords ~(100, 120-126), score 0.660 for red_ring
  - ItemReader correctly disambiguates shape twins (red_ring vs blue_ring) via color
  - 16x24 extraction window gives templates enough sliding room for robust matching
  - No new screen_type needed; staircase rooms classify as 'dungeon'
"""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from detector.item_reader import ItemReader

SCREENSHOT_DIR = os.path.join(
    os.path.dirname(__file__), "..", "data", "extracted-frames"
)
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates", "items")
OUTDIR = os.path.join(os.path.dirname(__file__), "debug_staircase")

# ── NES coordinates for staircase item positions (256x240 full-frame) ──
# Verified against BogieSmalls screenshots.
# HUD = rows 0-63, game area = rows 64-239.
#
# Pedestal: item rests on central platform. Sprite is 8x16 NES pixels.
#   Center approximately at NES (138, 148). With 16x24 extraction window,
#   the template slides 9 positions each direction — handles ±4px crop error.
#
# Hoisted: Link holds item overhead. Position depends on Link's x-position.
#   Center approximately at NES (102, 122). More variable than pedestal.

# Hot zone bounding boxes as (x, y, w, h) in NES full-frame coords.
# These are 16x24 to give 8x16 templates room to slide.
PEDESTAL_HOT_ZONE = (130, 138, 16, 24)   # item resting on platform
HOISTED_HOT_ZONE = (92, 112, 24, 32)     # item held above Link's head

# Known BogieSmalls stream crop (from stored profile)
BOGIE_CROP = {"x": 383, "y": 24, "w": 871, "h": 670}
STREAM_W, STREAM_H = 1280, 720


def find_nes_frame_from_desktop(screenshot: np.ndarray) -> np.ndarray | None:
    """Extract 256x240 NES frame from a desktop screenshot.

    Uses edge detection to find the NES game border, then computes scale
    from the known stream crop aspect ratio (871:670).
    """
    h, w = screenshot.shape[:2]
    gray = cv2.cvtColor(screenshot, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)

    # Find left boundary: strongest vertical edge where right side is dark (NES HUD)
    best_left, best_lc = 0, 0
    for x in range(200, w // 2):
        right_mean = float(gray[200:min(500, h), x:x + 5].mean())
        if right_mean > 5:
            continue
        count = int(np.sum(edges[100:min(1500, h - 50), x] > 0))
        if count > best_lc:
            best_lc = count
            best_left = x

    # Find bottom boundary: strongest horizontal edge in lower half
    best_bot, best_bc = 0, 0
    for y in range(h // 2, h):
        count = int(np.sum(edges[y, best_left:min(best_left + 2000, w)] > 0))
        if count > best_bc:
            best_bc = count
            best_bot = y

    # Find first visible content (NES content like LEVEL text, minimap)
    game_x_check = best_left + 200
    if game_x_check >= w:
        return None
    first_content_y = None
    for y in range(h):
        if gray[y, game_x_check] > 10:
            first_content_y = y
            break
    if first_content_y is None:
        return None

    # Calculate scale: first content at ~NES y=10, bottom edge at NES y=240
    crop_aspect = BOGIE_CROP["w"] / BOGIE_CROP["h"]
    scale_y = (best_bot - first_content_y) / 230.0
    if scale_y < 1.0:
        return None

    game_top = int(first_content_y - 10 * scale_y)
    game_height = int(240 * scale_y)
    game_width = int(game_height * crop_aspect)

    x1 = best_left
    y1 = max(0, game_top)
    x2 = min(w, x1 + game_width)
    y2 = min(h, y1 + game_height)

    region = screenshot[y1:y2, x1:x2]
    return cv2.resize(region, (256, 240), interpolation=cv2.INTER_NEAREST)


def scan_hot_zone(item_reader: ItemReader, frame: np.ndarray,
                  hot_zone: tuple[int, int, int, int], label: str):
    """Extract a hot zone and run item template matching."""
    x, y, w, h = hot_zone
    region = frame[max(0, y):min(240, y + h), max(0, x):min(256, x + w)]
    if region.size == 0:
        print(f"  {label}: empty region")
        return

    item = item_reader.read_item(region)
    scored = item_reader.read_item_scored(region)
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)

    print(f"  {label} ({x},{y},{w},{h}): match={item}, mean_brightness={gray.mean():.0f}")
    for name, score in (scored or [])[:5]:
        print(f"    {name:25s} {score:.3f}")

    # Save zoomed region
    big = cv2.resize(region, (region.shape[1] * 8, region.shape[0] * 8),
                     interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(os.path.join(OUTDIR, f"{label}.png"), big)


def systematic_scan(item_reader: ItemReader, frame: np.ndarray,
                    name: str) -> tuple[str | None, float, int, int]:
    """Slide a 16x24 window across center game area to find best item match."""
    best_item = None
    best_score = 0.0
    best_x, best_y = 0, 0

    for y in range(80, 220, 2):
        for x in range(88, 176, 2):
            region = frame[y:y + 24, x:x + 16]
            scored = item_reader.read_item_scored(region)
            if scored and scored[0][1] > best_score:
                best_score = scored[0][1]
                best_item = scored[0][0]
                best_x, best_y = x, y

    # Get the full item name (with color disambiguation)
    if best_score > 0.3:
        region = frame[best_y:best_y + 24, best_x:best_x + 16]
        full_item = item_reader.read_item(region)
        print(f"  {name} best: {full_item} at ({best_x},{best_y}) score={best_score:.3f}")
        big = cv2.resize(region, (128, 192), interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(os.path.join(OUTDIR, f"{name}_best.png"), big)
        return full_item, best_score, best_x, best_y
    else:
        print(f"  {name}: no confident match (best={best_score:.3f})")
        return None, best_score, best_x, best_y


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    item_reader = ItemReader(TEMPLATE_DIR)
    print(f"Loaded {len(item_reader.templates)} item templates")

    screenshots = sorted([
        f for f in os.listdir(SCREENSHOT_DIR)
        if f.startswith("Screenshot") and f.endswith(".jpg")
    ])
    print(f"Found {len(screenshots)} screenshots\n")

    for fname in screenshots:
        print(f"{'=' * 60}")
        print(f"Processing: {fname}")
        print(f"{'=' * 60}")

        path = os.path.join(SCREENSHOT_DIR, fname)
        screenshot = cv2.imread(path)
        if screenshot is None:
            print(f"  ERROR: Could not load {path}")
            continue

        print(f"  Size: {screenshot.shape[1]}x{screenshot.shape[0]}")

        frame = find_nes_frame_from_desktop(screenshot)
        if frame is None:
            print("  ERROR: Could not extract NES frame")
            continue

        tag = fname.replace(" ", "_").replace(".jpg", "")
        cv2.imwrite(os.path.join(OUTDIR, f"{tag}_canonical.png"), frame)

        # Hot zone matching
        print("\n--- Hot zone matching ---")
        scan_hot_zone(item_reader, frame, PEDESTAL_HOT_ZONE, f"{tag}_pedestal")
        scan_hot_zone(item_reader, frame, HOISTED_HOT_ZONE, f"{tag}_hoisted")

        # Systematic scan (find optimal position)
        print("\n--- Systematic 16x24 sliding scan ---")
        systematic_scan(item_reader, frame, tag)

        # Visualize hot zones on frame
        vis = frame.copy()
        for box, color, label in [
            (PEDESTAL_HOT_ZONE, (0, 255, 0), "PED"),
            (HOISTED_HOT_ZONE, (255, 255, 0), "HOIST"),
        ]:
            bx, by, bw, bh = box
            cv2.rectangle(vis, (bx, by), (bx + bw, by + bh), color, 1)
            cv2.putText(vis, label, (bx, by - 2), cv2.FONT_HERSHEY_SIMPLEX,
                        0.3, color, 1)
        big = cv2.resize(vis, (1024, 960), interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(os.path.join(OUTDIR, f"{tag}_vis.png"), big)
        print()

    print(f"\nDebug output saved to: {OUTDIR}/")


if __name__ == "__main__":
    main()
