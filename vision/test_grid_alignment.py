"""Diagnostic: compare find_grid_alignment scores at (2,2) vs (7,3) for Bogie's frame."""
import cv2
import numpy as np
from detector.auto_crop import find_grid_alignment

# Load the correctly-cropped canonical frame from Bogie
frame = cv2.imread('debug_canonical_correct.png')
if frame is None:
    print("No debug_canonical_correct.png — trying debug_correct_crop_900.png")
    frame = cv2.imread('debug_correct_crop_900.png')
if frame is None:
    print("No saved canonical frame found")
    exit(1)

# Resize to 256x240 if not already
h, w = frame.shape[:2]
if (w, h) != (256, 240):
    print(f"Resizing from {w}x{h} to 256x240")
    frame = cv2.resize(frame, (256, 240), interpolation=cv2.INTER_NEAREST)

print(f"Frame shape: {frame.shape}")

# Run the current algorithm
result = find_grid_alignment(frame)
print(f"\nfind_grid_alignment result: {result}")

# Score every (dx, dy, life_row) combination and show top 10
LIFE_COL = 22
CANDIDATE_ROWS = [3, 4, 5, 6]
all_scores = []

for life_row in CANDIDATE_ROWS:
    for dy in range(8):
        for dx in range(8):
            y = life_row * 8 + dy
            x = LIFE_COL * 8 + dx
            if x + 8 > 256 or y + 8 > 240:
                continue

            tile = frame[y:y + 8, x:x + 8]
            avg = np.mean(tile, axis=(0, 1))
            r, g, b = float(avg[2]), float(avg[1]), float(avg[0])

            if not (r > 50 and r > g * 2 and r > b * 2):
                continue

            score = r - (g + b) / 2

            # Bonus: col 23
            x2 = 23 * 8 + dx
            if x2 + 8 <= 256:
                tile2 = frame[y:y + 8, x2:x2 + 8]
                avg2 = np.mean(tile2, axis=(0, 1))
                r2 = float(avg2[2])
                if r2 > 50 and r2 > float(avg2[1]) * 2:
                    score += r2 / 2

            # Bonus: col 24
            x3 = 24 * 8 + dx
            if x3 + 8 <= 256:
                tile3 = frame[y:y + 8, x3:x3 + 8]
                avg3 = np.mean(tile3, axis=(0, 1))
                r3 = float(avg3[2])
                if r3 > 50 and r3 > float(avg3[1]) * 2:
                    score += r3 / 3

            # Hearts penalty: col 27
            x_beyond = 27 * 8 + dx
            penalty = ""
            if x_beyond + 8 <= 256:
                tile_beyond = frame[y:y + 8, x_beyond:x_beyond + 8]
                avg_beyond = np.mean(tile_beyond, axis=(0, 1))
                r_beyond = float(avg_beyond[2])
                if r_beyond > 50 and r_beyond > float(avg_beyond[1]) * 1.5:
                    score *= 0.1
                    penalty = " [HEARTS PENALTY]"

            all_scores.append((score, dx, dy, life_row, r, g, b, penalty))

all_scores.sort(key=lambda x: -x[0])
print(f"\nTop 15 scoring (dx, dy, life_row):")
for i, (score, dx, dy, life_row, r, g, b, penalty) in enumerate(all_scores[:15]):
    print(f"  {i+1}. score={score:.1f} dx={dx} dy={dy} row={life_row} "
          f"R={r:.0f} G={g:.0f} B={b:.0f}{penalty}")

# Detailed analysis of (2,2,5) and (7,3,5)
print("\n--- Detailed tile analysis ---")
for dx, dy, label in [(2, 2, "CORRECT"), (7, 3, "WRONG")]:
    print(f"\n{label}: dx={dx}, dy={dy}, life_row=5")
    y = 5 * 8 + dy
    for col in range(20, 28):
        x = col * 8 + dx
        if x + 8 > 256 or y + 8 > 240:
            print(f"  col {col}: OUT OF BOUNDS")
            continue
        tile = frame[y:y + 8, x:x + 8]
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        is_red = r > 50 and r > g * 2 and r > b * 2
        # Count actual red pixels
        r_ch = tile[:, :, 2].astype(float)
        g_ch = tile[:, :, 1].astype(float)
        b_ch = tile[:, :, 0].astype(float)
        red_px = int(np.sum((r_ch > 80) & (r_ch > g_ch * 2) & (r_ch > b_ch * 2)))
        print(f"  col {col} (x={x}): R={r:.0f} G={g:.0f} B={b:.0f} "
              f"red={'YES' if is_red else 'no '} red_px={red_px}/64")
