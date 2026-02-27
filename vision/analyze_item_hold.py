"""Analyze extracted frames to understand the 'item hold' pose at NES resolution.

Crops and resizes frames to 256x240, then analyzes the game area (rows 64-239)
for distinctive patterns during the Link item-hold animation.
"""

import os
import sys

import cv2
import numpy as np

# Crop coordinates from the v10 report
CROP_X, CROP_Y, CROP_W, CROP_H = 544, 0, 1376, 1080
NES_W, NES_H = 256, 240
HUD_HEIGHT = 64  # rows 0-63 are HUD


def to_nes(frame: np.ndarray) -> np.ndarray:
    """Crop and resize a full 1920x1080 frame to NES 256x240."""
    crop = frame[CROP_Y:CROP_Y + CROP_H, CROP_X:CROP_X + CROP_W]
    return cv2.resize(crop, (NES_W, NES_H), interpolation=cv2.INTER_NEAREST)


def analyze_game_area(nes_frame: np.ndarray, label: str):
    """Analyze the game area below the HUD."""
    game_area = nes_frame[HUD_HEIGHT:, :]  # 176 x 256

    # Orange/warm pixel detection (triforce piece color)
    # In BGR: orange is high B~100-200, G~100-200, R~200-255
    # In Zelda NES, the triforce color is typically (252, 152, 56) in RGB = (56, 152, 252) in BGR
    # But stream compression changes exact values
    b, g, r = cv2.split(game_area)

    # Detect warm/orange pixels: R > 150, G > 80, G < 200, B < 100
    orange_mask = (r > 150) & (g > 80) & (g < 200) & (b < 100)
    orange_count = np.count_nonzero(orange_mask)

    # Detect very dark pixels (black background)
    gray = cv2.cvtColor(game_area, cv2.COLOR_BGR2GRAY)
    dark_mask = gray < 30
    dark_pct = np.count_nonzero(dark_mask) / dark_mask.size * 100

    # Find orange clusters
    orange_u8 = orange_mask.astype(np.uint8) * 255
    contours, _ = cv2.findContours(orange_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    print(f'\n=== {label} ===')
    print(f'  Orange pixels: {orange_count} ({orange_count / game_area.size * 300:.1f}%)')
    print(f'  Dark pixels: {dark_pct:.1f}%')
    print(f'  Orange clusters: {len(contours)}')

    for i, c in enumerate(contours):
        area = cv2.contourArea(c)
        if area > 5:  # Skip tiny noise
            x, y, w, h = cv2.boundingRect(c)
            print(f'    Cluster {i}: area={area}, bbox=({x},{y},{w},{h})')

    # Also check for Link's skin color (NES Link is typically flesh-toned)
    # Flesh in BGR: B~100-180, G~140-220, R~180-255
    flesh_mask = (r > 180) & (g > 130) & (g < 220) & (b > 80) & (b < 180)
    flesh_count = np.count_nonzero(flesh_mask)
    print(f'  Flesh-tone pixels: {flesh_count}')

    return orange_mask, game_area


def save_annotated(nes_frame: np.ndarray, orange_mask: np.ndarray, path: str):
    """Save NES frame with orange areas highlighted."""
    vis = nes_frame.copy()
    # Scale up 3x for visibility
    vis = cv2.resize(vis, (NES_W * 3, NES_H * 3), interpolation=cv2.INTER_NEAREST)

    # Highlight orange on game area
    mask_full = np.zeros((NES_H, NES_W), dtype=np.uint8)
    mask_full[HUD_HEIGHT:, :] = orange_mask.astype(np.uint8) * 255
    mask_up = cv2.resize(mask_full, (NES_W * 3, NES_H * 3), interpolation=cv2.INTER_NEAREST)

    # Draw green overlay on orange pixels
    vis[mask_up > 0] = [0, 255, 0]

    cv2.imwrite(path, vis)


def main():
    frames_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              'data', 'extracted-frames')
    output_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              'data', 'nes-analysis')
    os.makedirs(output_dir, exist_ok=True)

    # Analyze key frames from each triforce pickup
    key_frames = [
        # L3: pre-pickup, item on ground, item-hold, flash
        ('L3_triforce_29m30s_f018.jpg', 'L3 pre-pickup (dungeon, item on ground)'),
        ('L3_triforce_29m31s_f020.jpg', 'L3 pickup (Link grabs item)'),
        ('L3_triforce_29m31s_f021.jpg', 'L3 item-hold (Link holds triforce)'),
        ('L3_triforce_29m33s_f028.jpg', 'L3 hold+refill (hearts filling)'),
        # L8: pre-pickup, item-hold
        ('L8_triforce_57m41s_f019.jpg', 'L8 flash (white screen)'),
        ('L8_triforce_57m42s_f022.jpg', 'L8 item-hold (orange triforce above)'),
        ('L8_triforce_57m42s_f023.jpg', 'L8 item-hold (continues)'),
        # L6: pre-pickup, item-hold
        ('L6_triforce_66m23s_f019.jpg', 'L6 item-hold (triforce above Link)'),
        ('L6_triforce_66m24s_f022.jpg', 'L6 item-hold (continues)'),
        ('L6_triforce_66m25s_f024.jpg', 'L6 hold+refill (hearts filling)'),
        # Also a normal dungeon frame for comparison
        ('L3_triforce_29m26s_f000.jpg', 'L3 normal dungeon (no item hold)'),
        ('L8_triforce_57m37s_f000.jpg', 'L8 normal dungeon (no item hold)'),
    ]

    for fname, label in key_frames:
        path = os.path.join(frames_dir, fname)
        if not os.path.exists(path):
            print(f'  SKIP: {fname} not found')
            continue

        frame = cv2.imread(path)
        if frame is None:
            print(f'  SKIP: {fname} could not be read')
            continue

        nes = to_nes(frame)
        orange_mask, game_area = analyze_game_area(nes, label)

        # Save annotated NES frame
        out_path = os.path.join(output_dir, f'nes_{fname}')
        save_annotated(nes, orange_mask, out_path)

    print(f'\nAnnotated frames saved to {output_dir}')


if __name__ == '__main__':
    main()
