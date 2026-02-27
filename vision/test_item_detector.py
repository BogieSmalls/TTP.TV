"""Test the item detector against reference frames."""

import os
import cv2
import numpy as np

from vision.detector.item_detector import ItemDetector

CROP_X, CROP_Y, CROP_W, CROP_H = 544, 0, 1376, 1080
NES_W, NES_H = 256, 240


def to_nes(frame):
    crop = frame[CROP_Y:CROP_Y + CROP_H, CROP_X:CROP_X + CROP_W]
    return cv2.resize(crop, (NES_W, NES_H), interpolation=cv2.INTER_NEAREST)


def main():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    frames_dir = os.path.join(base, 'data', 'extracted-frames')

    detector = ItemDetector()

    # Test frames: (filename, expected_item, description)
    test_cases = [
        # Item-hold frames (should detect triforce)
        ('L3_triforce_29m31s_f021.jpg', 'triforce', 'L3 item-hold'),
        ('L3_triforce_29m31s_f022.jpg', 'triforce', 'L3 item-hold +1'),
        ('L3_triforce_29m32s_f024.jpg', 'triforce', 'L3 hold+refill'),
        ('L8_triforce_57m42s_f022.jpg', 'triforce', 'L8 item-hold'),
        ('L8_triforce_57m42s_f023.jpg', 'triforce', 'L8 item-hold +1'),
        ('L6_triforce_66m23s_f019.jpg', 'triforce', 'L6 item-hold'),
        ('L6_triforce_66m24s_f022.jpg', 'triforce', 'L6 item-hold +1'),
        # Flash frames (triforce changes color — may not detect)
        ('L3_triforce_29m33s_f028.jpg', None, 'L3 flash (no orange)'),
        ('L8_triforce_57m41s_f019.jpg', None, 'L8 white flash'),
        # Normal dungeon gameplay (should NOT detect triforce, or detect at different y)
        ('L3_triforce_29m26s_f000.jpg', None, 'L3 normal gameplay'),
        ('L3_triforce_29m30s_f018.jpg', None, 'L3 pre-pickup (triforce on ground)'),
        ('L8_triforce_57m37s_f000.jpg', None, 'L8 normal gameplay'),
    ]

    print(f'{"Frame":<45} {"Expected":<12} {"Detected":<12} {"Y":>4} {"Conf":>5} {"OK?"}')
    print('-' * 95)

    for fname, expected, desc in test_cases:
        path = os.path.join(frames_dir, fname)
        if not os.path.exists(path):
            print(f'{desc:<45} SKIP (file not found)')
            continue

        frame = cv2.imread(path)
        nes = to_nes(frame)

        items = detector.detect_items(nes, 'dungeon')
        if items:
            item = items[0]
            detected = item.item_type
            y = item.y
            conf = item.confidence
        else:
            detected = None
            y = -1
            conf = 0.0

        # For pre-pickup, the triforce is on the ground — it WILL be detected
        # but we note it. The temporal tracking in game_logic.py handles this.
        ok = 'YES' if detected == expected else 'no'

        print(f'{desc:<45} {str(expected):<12} {str(detected):<12} {y:>4} {conf:>5.2f} {ok}')


if __name__ == '__main__':
    main()
