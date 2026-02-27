"""Extract specific frames from a VOD at given timestamps.

Usage:
    python -m vision.extract_frames <source> --timestamps 29:31,57:42,66:24 --window 5

Extracts frames in a window around each timestamp, saving them as images.
"""

import argparse
import os
import subprocess
import sys

import cv2
import numpy as np


def resolve_source(source: str) -> tuple[str, bool]:
    """Resolve Twitch VOD URLs via streamlink."""
    is_twitch = 'twitch.tv' in source
    if not is_twitch:
        return source, False

    print(f'Resolving Twitch VOD URL via streamlink...', file=sys.stderr)
    try:
        sl = subprocess.run(
            ['streamlink', source, 'best', '--stream-url'],
            capture_output=True, text=True, timeout=30,
        )
        if sl.returncode == 0 and sl.stdout.strip():
            return sl.stdout.strip(), False
    except Exception as e:
        print(f'streamlink failed: {e}', file=sys.stderr)
    return source, True


def parse_timestamp(ts: str) -> float:
    """Parse MM:SS or HH:MM:SS or seconds to float."""
    parts = ts.strip().split(':')
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    elif len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return float(ts)


def extract_window(source: str, needs_pipe: bool, timestamp_s: float,
                   window_s: float, fps: int, width: int, height: int,
                   output_dir: str, label: str) -> list[str]:
    """Extract frames in a window around a timestamp."""
    start = max(0, timestamp_s - window_s)
    duration = window_s * 2

    ff_cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'warning',
        '-ss', str(start),
        '-i', source,
        '-t', str(duration),
        '-vf', f'fps={fps},scale={width}:{height}',
        '-pix_fmt', 'bgr24', '-vcodec', 'rawvideo',
        '-f', 'rawvideo', 'pipe:1',
    ]

    proc = subprocess.Popen(ff_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    frame_size = width * height * 3
    saved = []
    frame_idx = 0

    while True:
        raw = proc.stdout.read(frame_size)
        if len(raw) < frame_size:
            break

        frame = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3))
        t = start + frame_idx / fps
        mm = int(t // 60)
        ss = int(t % 60)
        fname = f'{label}_{mm:02d}m{ss:02d}s_f{frame_idx:03d}.jpg'
        path = os.path.join(output_dir, fname)
        cv2.imwrite(path, frame)
        saved.append(path)
        frame_idx += 1

    proc.wait()
    return saved


def main():
    parser = argparse.ArgumentParser(description='Extract frames at specific timestamps')
    parser.add_argument('source', help='Video source (file path or Twitch URL)')
    parser.add_argument('--timestamps', required=True,
                        help='Comma-separated timestamps (MM:SS or HH:MM:SS)')
    parser.add_argument('--labels', default=None,
                        help='Comma-separated labels for each timestamp')
    parser.add_argument('--window', type=float, default=5.0,
                        help='Seconds before/after timestamp (default 5)')
    parser.add_argument('--fps', type=int, default=4,
                        help='Frames per second (default 4)')
    parser.add_argument('--width', type=int, default=1920)
    parser.add_argument('--height', type=int, default=1080)
    parser.add_argument('--output-dir', default=None,
                        help='Output directory (default: data/extracted-frames)')
    args = parser.parse_args()

    timestamps = [parse_timestamp(t) for t in args.timestamps.split(',')]
    labels = args.labels.split(',') if args.labels else [f'ts{i}' for i in range(len(timestamps))]

    output_dir = args.output_dir or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        'data', 'extracted-frames',
    )
    os.makedirs(output_dir, exist_ok=True)

    source, needs_pipe = resolve_source(args.source)

    for ts, label in zip(timestamps, labels):
        mm = int(ts // 60)
        ss = int(ts % 60)
        print(f'Extracting {label} at {mm:02d}:{ss:02d} +/- {args.window}s ...', file=sys.stderr)
        saved = extract_window(source, needs_pipe, ts, args.window, args.fps,
                               args.width, args.height, output_dir, label)
        print(f'  Saved {len(saved)} frames', file=sys.stderr)

    print(f'Frames saved to {output_dir}', file=sys.stderr)


if __name__ == '__main__':
    main()
