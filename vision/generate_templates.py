"""Generate 8x8 NES digit template images for vision detection.

Creates grayscale PNG files for digits 0-9 from standard NES font bitmaps.
These templates are used by digit_reader.py for template matching.

Usage:
    python generate_templates.py
"""

import os
import numpy as np
import cv2

# Standard NES font bitmaps for digits 0-9.
# Each digit is 8 rows of 8 pixels, encoded as bytes (MSB = leftmost pixel).
NES_DIGITS = {
    0: [0x3C, 0x66, 0x6E, 0x7E, 0x76, 0x66, 0x3C, 0x00],
    1: [0x18, 0x38, 0x18, 0x18, 0x18, 0x18, 0x7E, 0x00],
    2: [0x3C, 0x66, 0x06, 0x0C, 0x18, 0x30, 0x7E, 0x00],
    3: [0x3C, 0x66, 0x06, 0x1C, 0x06, 0x66, 0x3C, 0x00],
    4: [0x0C, 0x1C, 0x3C, 0x6C, 0x7E, 0x0C, 0x0C, 0x00],
    5: [0x7E, 0x60, 0x7C, 0x06, 0x06, 0x66, 0x3C, 0x00],
    6: [0x1C, 0x30, 0x60, 0x7C, 0x66, 0x66, 0x3C, 0x00],
    7: [0x7E, 0x06, 0x0C, 0x18, 0x18, 0x18, 0x18, 0x00],
    8: [0x3C, 0x66, 0x66, 0x3C, 0x66, 0x66, 0x3C, 0x00],
    9: [0x3C, 0x66, 0x66, 0x3E, 0x06, 0x0C, 0x38, 0x00],
}


def bitmap_to_image(rows: list[int]) -> np.ndarray:
    """Convert 8 bitmap bytes to an 8x8 grayscale numpy array."""
    img = np.zeros((8, 8), dtype=np.uint8)
    for y, row_byte in enumerate(rows):
        for x in range(8):
            if row_byte & (0x80 >> x):
                img[y, x] = 255
    return img


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    digits_dir = os.path.join(script_dir, 'templates', 'digits')
    os.makedirs(digits_dir, exist_ok=True)

    for digit, rows in NES_DIGITS.items():
        img = bitmap_to_image(rows)
        path = os.path.join(digits_dir, f'{digit}.png')
        cv2.imwrite(path, img)
        print(f'  Created {path} ({img.shape})')

    # Create placeholder directories for future templates
    for subdir in ('items', 'triforce'):
        os.makedirs(os.path.join(script_dir, 'templates', subdir), exist_ok=True)

    print(f'\nGenerated {len(NES_DIGITS)} digit templates in {digits_dir}')


if __name__ == '__main__':
    main()
