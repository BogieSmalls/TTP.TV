import cv2
import numpy as np

canonical = cv2.imread('debug_bogie_fixed_canonical.png')
h, w = canonical.shape[:2]
if w != 256 or h != 240:
    canonical = cv2.resize(canonical, (256, 240), interpolation=cv2.INTER_NEAREST)

print('ALL bright pixels in HUD (brightness > 40):')
for y in range(64):
    row = canonical[y, :, :]
    bright = np.mean(row, axis=1) > 40
    bright_x = np.where(bright)[0]
    if len(bright_x) > 0:
        clusters = []
        start = int(bright_x[0])
        prev = int(bright_x[0])
        for x in bright_x[1:]:
            x = int(x)
            if x - prev > 3:
                clusters.append(f'{start}-{prev}')
                start = x
            prev = x
        clusters.append(f'{start}-{prev}')
        print(f'  y={y}: {" | ".join(clusters)}')

print()
print('Red-dominant pixels (R>40, R>G*1.5, R>B*1.5) in full HUD:')
for y in range(64):
    row = canonical[y, :, :]
    r = row[:, 2].astype(float)
    g = row[:, 1].astype(float)
    b = row[:, 0].astype(float)
    red = np.where((r > 40) & (r > g * 1.5) & (r > b * 1.5))[0]
    if len(red) > 0:
        print(f'  y={y}: x={list(int(x) for x in red[:20])}')
