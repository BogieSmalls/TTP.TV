"""Debug dungeon level detection for Bogie's 1800s frame."""
import cv2
import numpy as np
from detector.hud_reader import HudReader
from detector.digit_reader import DigitReader
from detector.nes_frame import NESFrame, extract_nes_crop

# Bogie's config
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

GRID_DX, GRID_DY = 2, 0
hud = HudReader(landmarks=LANDMARKS)
digit_reader = DigitReader('templates/digits')

print(f"LEVEL_TEXT_ROW={hud.LEVEL_TEXT_ROW}, LEVEL_TEXT_COLS={hud.LEVEL_TEXT_COLS}")
print(f"LEVEL_DIGIT_COL={hud.LEVEL_DIGIT_COL}, LEVEL_DIGIT_ROW={hud.LEVEL_DIGIT_ROW}")
print(f"grid_dx={GRID_DX}, grid_dy={GRID_DY} (on NESFrame)")

# Build NESFrames
nf_canon = NESFrame(canonical, 1.0, 1.0, grid_dx=GRID_DX, grid_dy=GRID_DY)
nf_stream = NESFrame(extract_nes_crop(stream, CROP_X, CROP_Y, CROP_W, CROP_H),
                     CROP_W / 256.0, CROP_H / 240.0,
                     grid_dx=GRID_DX, grid_dy=GRID_DY)

# Check what the LEVEL text region looks like
text_start_col = hud.LEVEL_TEXT_COLS[0]
text_end_col = hud.LEVEL_TEXT_COLS[1]
adj_row = hud.LEVEL_TEXT_ROW
rx = text_start_col * 8 + GRID_DX
ry = adj_row * 8 + GRID_DY
rw = (text_end_col + 1 - text_start_col) * 8
print(f"\nLEVEL text region: NES ({rx}, {ry}) size ({rw}, 8)")
print(f"  Stream pos: ({CROP_X + rx * CROP_W / 256:.0f}, {CROP_Y + ry * CROP_H / 240:.0f})")

# Extract without stream source (canonical)
text_region_canon = nf_canon.extract(rx, ry, rw, 8)
print(f"\n  Canonical text region: mean={np.mean(text_region_canon):.1f}")

# Extract with stream source
text_region_stream = nf_stream.extract(rx, ry, rw, 8)
print(f"  Stream text region: mean={np.mean(text_region_stream):.1f}")

# Save enlarged regions for visual inspection
cv2.imwrite('debug_level_text_canon.png',
            cv2.resize(text_region_canon, (rw*8, 64), interpolation=cv2.INTER_NEAREST))
cv2.imwrite('debug_level_text_stream.png',
            cv2.resize(text_region_stream, (rw*8, 64), interpolation=cv2.INTER_NEAREST))

# Try the full read_dungeon_level
level_canon = hud.read_dungeon_level(nf_canon, digit_reader)
print(f"\n  Canon dungeon_level: {level_canon}")

level_stream = hud.read_dungeon_level(nf_stream, digit_reader)
print(f"  Stream dungeon_level: {level_stream}")

# Now let's check the LVL landmark area directly
print("\n--- Scanning LVL landmark area directly ---")
lm = next(l for l in LANDMARKS if l['label'] == 'LVL')
lx, ly, lw, lh = lm['x'], lm['y'], lm['w'], lm['h']
print(f"LVL landmark: ({lx}, {ly}) size ({lw}, {lh})")

# Extract the landmark region from canonical
region_canon = canonical[ly:ly+lh, lx:lx+lw]
print(f"Canon region brightness: {np.mean(region_canon):.1f}")

# Extract from stream
region_stream = nf_stream.extract(lx, ly, lw, lh)
print(f"Stream region brightness: {np.mean(region_stream):.1f}")

cv2.imwrite('debug_lvl_region_canon.png',
            cv2.resize(region_canon, (lw*8, lh*8), interpolation=cv2.INTER_NEAREST))
cv2.imwrite('debug_lvl_region_stream.png',
            cv2.resize(region_stream, (lw*8, lh*8), interpolation=cv2.INTER_NEAREST))

# Scan for any bright text in rows 0-3 around the LVL area
print("\n--- Brightness scan of HUD rows 0-4 ---")
for row in range(5):
    for col in range(0, 12):
        tile = nf_canon.tile(col, row)
        brightness = float(np.mean(tile))
        if brightness > 10:
            print(f"  tile ({col}, {row}) NES ({col*8+GRID_DX}, {row*8+GRID_DY}): brightness={brightness:.1f}")

# Also check digit reading at various positions around LEVEL
print("\n--- Digit scan around LEVEL area (stream) ---")
for row in range(4):
    for col in range(8, 12):
        tile = nf_stream.tile(col, row)
        d = digit_reader.read_digit(tile)
        brightness = float(np.mean(tile))
        if d is not None or brightness > 10:
            print(f"  tile ({col}, {row}): digit={d} brightness={brightness:.1f}")
