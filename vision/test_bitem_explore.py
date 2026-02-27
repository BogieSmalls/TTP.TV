"""Explore B-item tile region to find the actual sprite position and structure."""
import cv2
import numpy as np
from detector.hud_reader import HudReader

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

stream = cv2.imread('debug_full_1800s.png')
if stream is None:
    print("No debug_full_1800s.png"); exit(1)

# Create canonical
fh, fw = stream.shape[:2]
y1, y2 = CROP_Y, CROP_Y + CROP_H
x1, x2 = CROP_X, CROP_X + CROP_W
sy1, sy2 = max(0, y1), min(fh, y2)
sx1, sx2 = max(0, x1), min(fw, x2)
dy_off = sy1 - y1
dx_off = sx1 - x1
nes_region = np.zeros((CROP_H, CROP_W, 3), dtype=np.uint8)
nes_region[dy_off:dy_off + (sy2 - sy1),
           dx_off:dx_off + (sx2 - sx1)] = stream[sy1:sy2, sx1:sx2]
canonical = cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)

hud = HudReader(grid_offset=(2, 0), landmarks=LANDMARKS)
hud.set_stream_source(stream, CROP_X, CROP_Y, CROP_W, CROP_H)

# Extract a wider area around B-item to see HUD layout
print("=== B-item area pixel scan (stream extraction) ===")
print("Extracting 24x24 area centered on B landmark")
bx, by = 124, 24  # B landmark position
wide = hud._extract(canonical, bx - 4, by - 4, 24, 24)

print("\nGrayscale pixel values (24x24):")
gray = cv2.cvtColor(wide, cv2.COLOR_BGR2GRAY)
for row in range(24):
    vals = [f"{gray[row, col]:3d}" for col in range(24)]
    marker = " <-- y=" + str(by - 4 + row)
    print(f"  row {row:2d}: {' '.join(vals)}{marker}")

print("\nBlue channel (24x24):")
for row in range(24):
    vals = [f"{wide[row, col, 0]:3d}" for col in range(24)]
    print(f"  row {row:2d}: {' '.join(vals)}")

print("\nRed channel (24x24):")
for row in range(24):
    vals = [f"{wide[row, col, 2]:3d}" for col in range(24)]
    print(f"  row {row:2d}: {' '.join(vals)}")

# Now extract just the inner 8x16 region (skip border)
# Try several offsets to find cleanest extraction
print("\n=== Testing different extraction offsets ===")
for dx_off in range(0, 10, 2):
    for dy_off in [0, 2, 4]:
        inner = hud._extract(canonical, bx + dx_off, by + dy_off, 8, 16)
        brightness = float(np.mean(inner))
        # Count non-black pixels
        gray_inner = cv2.cvtColor(inner, cv2.COLOR_BGR2GRAY)
        nonblack = np.sum(gray_inner > 20)
        print(f"  offset (+{dx_off}, +{dy_off}): brightness={brightness:.1f}, "
              f"nonblack={nonblack}/128")

# Save the 16x16 B-item at landmark pos and at offset +4
tile_at_lm = hud._extract(canonical, bx, by, 16, 16)
tile_inner = hud._extract(canonical, bx + 4, by, 8, 16)
cv2.imwrite('debug_bitem_at_landmark.png',
            cv2.resize(tile_at_lm, (128, 128), interpolation=cv2.INTER_NEAREST))
cv2.imwrite('debug_bitem_inner_8x16.png',
            cv2.resize(tile_inner, (64, 128), interpolation=cv2.INTER_NEAREST))

# Also save canonical HUD region for reference
hud_region = canonical[0:64, 100:170]
cv2.imwrite('debug_hud_bitem_area.png',
            cv2.resize(hud_region, (560, 512), interpolation=cv2.INTER_NEAREST))

hud.clear_stream_source()
