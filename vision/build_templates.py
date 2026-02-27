"""Extract item templates from reference frames for item-hold detection.

Extracts the triforce piece sprite from the L3 item-hold frame where
the background is black (cleanest isolation).
"""

import os
import cv2
import numpy as np

CROP_X, CROP_Y, CROP_W, CROP_H = 544, 0, 1376, 1080
NES_W, NES_H = 256, 240
HUD_HEIGHT = 64


def to_nes(frame: np.ndarray) -> np.ndarray:
    crop = frame[CROP_Y:CROP_Y + CROP_H, CROP_X:CROP_X + CROP_W]
    return cv2.resize(crop, (NES_W, NES_H), interpolation=cv2.INTER_NEAREST)


def extract_triforce_template():
    """Extract triforce piece template from L3 item-hold frame."""
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    frames_dir = os.path.join(base, 'data', 'extracted-frames')

    # Use L3 item-hold frame (dark background = cleanest isolation)
    path = os.path.join(frames_dir, 'L3_triforce_29m31s_f021.jpg')
    frame = cv2.imread(path)
    nes = to_nes(frame)
    game_area = nes[HUD_HEIGHT:, :]

    # Find the orange cluster (triforce piece)
    b, g, r = cv2.split(game_area)
    orange_mask = (r > 150) & (g > 80) & (g < 200) & (b < 100)
    orange_u8 = orange_mask.astype(np.uint8) * 255

    contours, _ = cv2.findContours(orange_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    # Find the main triforce cluster (area ~45)
    best = None
    best_area = 0
    for c in contours:
        area = cv2.contourArea(c)
        if 30 < area < 70 and area > best_area:
            best = c
            best_area = area

    if best is None:
        print('ERROR: Could not find triforce cluster')
        return

    x, y, w, h = cv2.boundingRect(best)
    print(f'Triforce cluster: area={best_area}, bbox=({x},{y},{w},{h})')

    # Extract with 2px padding
    pad = 2
    x1 = max(0, x - pad)
    y1 = max(0, y - pad)
    x2 = min(game_area.shape[1], x + w + pad)
    y2 = min(game_area.shape[0], y + h + pad)

    template_bgr = game_area[y1:y2, x1:x2].copy()
    template_mask = orange_u8[y1:y2, x1:x2]

    print(f'Template size: {template_bgr.shape}')
    print(f'Template mask non-zero: {np.count_nonzero(template_mask)}')

    # Save template
    templates_dir = os.path.join(base, 'templates', 'items')
    os.makedirs(templates_dir, exist_ok=True)

    # Save the color template
    cv2.imwrite(os.path.join(templates_dir, 'triforce_piece.png'), template_bgr)
    cv2.imwrite(os.path.join(templates_dir, 'triforce_piece_mask.png'), template_mask)

    # Also save scaled-up versions for visual inspection
    scale = 8
    cv2.imwrite(os.path.join(templates_dir, 'triforce_piece_8x.png'),
                cv2.resize(template_bgr, (template_bgr.shape[1]*scale, template_bgr.shape[0]*scale),
                           interpolation=cv2.INTER_NEAREST))
    cv2.imwrite(os.path.join(templates_dir, 'triforce_piece_mask_8x.png'),
                cv2.resize(template_mask, (template_mask.shape[1]*scale, template_mask.shape[0]*scale),
                           interpolation=cv2.INTER_NEAREST))

    # Print pixel values for the orange area
    print('\nTemplate BGR values (orange pixels only):')
    for row in range(template_mask.shape[0]):
        for col in range(template_mask.shape[1]):
            if template_mask[row, col] > 0:
                px = template_bgr[row, col]
                print(f'  ({row},{col}): B={px[0]} G={px[1]} R={px[2]}')

    # Also extract from L8 and L6 for comparison
    for fname, label in [
        ('L8_triforce_57m42s_f022.jpg', 'L8'),
        ('L6_triforce_66m23s_f019.jpg', 'L6'),
    ]:
        path2 = os.path.join(frames_dir, fname)
        frame2 = cv2.imread(path2)
        nes2 = to_nes(frame2)
        ga2 = nes2[HUD_HEIGHT:, :]
        b2, g2, r2 = cv2.split(ga2)
        mask2 = (r2 > 150) & (g2 > 80) & (g2 < 200) & (b2 < 100)
        u8_2 = mask2.astype(np.uint8) * 255
        contours2, _ = cv2.findContours(u8_2, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c2 in contours2:
            a2 = cv2.contourArea(c2)
            if 30 < a2 < 70:
                x2, y2, w2, h2 = cv2.boundingRect(c2)
                template2 = ga2[y2:y2+h2, x2:x2+w2]
                print(f'\n{label} triforce: area={a2}, bbox=({x2},{y2},{w2},{h2})')
                cv2.imwrite(os.path.join(templates_dir, f'triforce_piece_{label}.png'), template2)
                cv2.imwrite(os.path.join(templates_dir, f'triforce_piece_{label}_8x.png'),
                            cv2.resize(template2, (template2.shape[1]*8, template2.shape[0]*8),
                                       interpolation=cv2.INTER_NEAREST))


if __name__ == '__main__':
    extract_triforce_template()
