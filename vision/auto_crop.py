"""Auto-detect game area in a stream screenshot by finding non-black content bounds.

Usage:
    python auto_crop.py --inputs <path1> [path2 ...]

Outputs JSON to stdout:
    {
        "crop_x": int, "crop_y": int, "crop_w": int, "crop_h": int,
        "stream_width": int, "stream_height": int,
        "confidence": float
    }

Works by thresholding the image to separate black borders from game content,
then finding the bounding box of the content region. When multiple inputs are
given, results are averaged for more stable detection.
"""

import argparse
import json
import sys

try:
    from PIL import Image
    import numpy as np
except ImportError:
    print("Error: Pillow and numpy are required. Install with: pip install Pillow numpy", file=sys.stderr)
    sys.exit(1)


def detect_content_bounds(image_path: str, threshold: int = 15, padding: int = 4) -> dict | None:
    """Detect the non-black content region in a screenshot.

    Args:
        image_path: Path to the screenshot image.
        threshold: Pixel brightness threshold (0-255). Pixels brighter than
                   this in any channel are considered content.
        padding: Pixels of padding to add around detected bounds.

    Returns:
        Dict with crop_x, crop_y, crop_w, crop_h, stream_width, stream_height,
        confidence — or None if detection fails.
    """
    try:
        img = Image.open(image_path).convert('RGB')
    except Exception as e:
        print(f'[auto_crop] Failed to open {image_path}: {e}', file=sys.stderr)
        return None

    arr = np.array(img)
    h, w = arr.shape[:2]

    # Mask: any pixel where max channel value exceeds threshold
    bright = arr.max(axis=2) > threshold

    if not bright.any():
        print(f'[auto_crop] No bright pixels found in {image_path}', file=sys.stderr)
        return None

    # Find bounding box of bright region
    rows = np.any(bright, axis=1)
    cols = np.any(bright, axis=0)
    y_min, y_max = np.where(rows)[0][[0, -1]]
    x_min, x_max = np.where(cols)[0][[0, -1]]

    # Apply padding
    x_min = max(0, int(x_min) - padding)
    y_min = max(0, int(y_min) - padding)
    x_max = min(w - 1, int(x_max) + padding)
    y_max = min(h - 1, int(y_max) + padding)

    crop_w = x_max - x_min + 1
    crop_h = y_max - y_min + 1

    # Confidence: how much area was cropped away. If we removed a significant
    # portion of the frame, we're more confident the detection is meaningful.
    total_pixels = w * h
    content_pixels = crop_w * crop_h
    crop_ratio = 1.0 - (content_pixels / total_pixels)

    # If almost nothing was cropped, confidence is low (likely a full-screen game)
    # If a moderate amount was cropped, confidence is high
    # If too much was cropped, something may be wrong
    if crop_ratio < 0.02:
        confidence = 0.3  # Basically full frame — not much to crop
    elif crop_ratio > 0.7:
        confidence = 0.4  # Cropped too much — might be wrong
    else:
        confidence = min(0.95, 0.5 + crop_ratio)

    return {
        'crop_x': x_min,
        'crop_y': y_min,
        'crop_w': crop_w,
        'crop_h': crop_h,
        'stream_width': w,
        'stream_height': h,
        'confidence': round(confidence, 3),
    }


def main():
    parser = argparse.ArgumentParser(description='Auto-detect game crop from screenshots')
    parser.add_argument('--inputs', nargs='+', required=True, help='Screenshot image paths')
    parser.add_argument('--threshold', type=int, default=15, help='Brightness threshold (0-255)')
    parser.add_argument('--padding', type=int, default=4, help='Padding pixels around detected area')
    args = parser.parse_args()

    results = []
    for path in args.inputs:
        result = detect_content_bounds(path, args.threshold, args.padding)
        if result:
            results.append(result)
            print(f'[auto_crop] {path}: {result["crop_w"]}x{result["crop_h"]} at ({result["crop_x"]},{result["crop_y"]}) conf={result["confidence"]}', file=sys.stderr)

    if not results:
        print(json.dumps({
            'error': 'No valid detections',
            'crop_x': 0, 'crop_y': 0, 'crop_w': 1920, 'crop_h': 1080,
            'stream_width': 1920, 'stream_height': 1080,
            'confidence': 0.0,
        }))
        sys.exit(0)

    # Average results across all input images for stability
    avg = {}
    for key in ('crop_x', 'crop_y', 'crop_w', 'crop_h', 'stream_width', 'stream_height', 'confidence'):
        values = [r[key] for r in results]
        if key == 'confidence':
            avg[key] = round(sum(values) / len(values), 3)
        else:
            avg[key] = round(sum(values) / len(values))

    print(json.dumps(avg))


if __name__ == '__main__':
    main()
