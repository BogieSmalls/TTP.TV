"""Extract full-resolution screenshots from a video source for crop profile definition.

Usage:
    python extract_screenshot.py --source <url_or_file> --output-dir <dir>
        [--timestamps <t1,t2,...>] [--count 5]

Outputs JSON manifest to stdout with screenshot info.
"""

import argparse
import json
import os
import subprocess
import sys


def resolve_source(source: str, twitch_token: str | None = None) -> tuple[str, bool]:
    """Resolve Twitch/YouTube VOD URLs to direct stream URLs for fast seeking."""
    is_twitch = 'twitch.tv' in source
    is_youtube = 'youtube.com' in source or 'youtu.be' in source

    if is_youtube:
        print(f'[Screenshot] Resolving YouTube URL via yt-dlp...', file=sys.stderr)
        try:
            yt = subprocess.run(
                ['yt-dlp', '--get-url', '-f', 'best', source],
                capture_output=True, text=True, timeout=60,
            )
            if yt.returncode == 0 and yt.stdout.strip():
                direct_url = yt.stdout.strip().split('\n')[0]
                print(f'[Screenshot] Resolved YouTube to direct URL', file=sys.stderr)
                return direct_url, False
        except Exception as e:
            print(f'[Screenshot] yt-dlp failed: {e}, trying direct URL', file=sys.stderr)
        return source, False

    if not is_twitch:
        return source, False

    print(f'[Screenshot] Resolving Twitch via streamlink...', file=sys.stderr)
    try:
        sl_args = ['streamlink', source, 'best', '--stream-url']
        if twitch_token:
            sl_args.extend(['--twitch-api-header', f'Authorization=OAuth {twitch_token}'])
        sl = subprocess.run(
            sl_args,
            capture_output=True, text=True, timeout=30,
        )
        if sl.returncode == 0 and sl.stdout.strip():
            print(f'[Screenshot] Resolved to direct URL', file=sys.stderr)
            return sl.stdout.strip(), False
    except Exception as e:
        print(f'[Screenshot] streamlink failed: {e}', file=sys.stderr)

    return source, True


def probe_resolution(source: str) -> tuple[int, int]:
    """Detect video resolution via ffprobe. Returns (width, height)."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height',
             '-of', 'json', source],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout)
            streams = data.get('streams', [])
            if streams:
                w = int(streams[0].get('width', 0))
                h = int(streams[0].get('height', 0))
                if w > 0 and h > 0:
                    return w, h
    except Exception as e:
        print(f'[Screenshot] ffprobe failed: {e}', file=sys.stderr)
    return 1920, 1080


def probe_duration(source: str) -> float:
    """Detect video duration in seconds via ffprobe."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
             '-of', 'json', source],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout)
            duration = data.get('format', {}).get('duration')
            if duration:
                return float(duration)
    except Exception:
        pass
    return 600.0  # default 10 minutes


def extract_frame(source: str, timestamp: float, output_path: str, width: int, height: int) -> bool:
    """Extract a single frame at the given timestamp."""
    cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'warning',
        '-ss', str(timestamp),
        '-i', source,
        '-vframes', '1',
        '-q:v', '2',  # high quality JPEG
        output_path,
        '-y',
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return result.returncode == 0 and os.path.exists(output_path)
    except Exception as e:
        print(f'[Screenshot] ffmpeg failed at {timestamp}s: {e}', file=sys.stderr)
        return False


def format_timestamp(seconds: float) -> str:
    """Format seconds as HH:MM:SS for filenames."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    if h > 0:
        return f'{h:02d}h{m:02d}m{s:02d}s'
    return f'{m:02d}m{s:02d}s'


def main():
    parser = argparse.ArgumentParser(description='Extract screenshots from video for crop definition')
    parser.add_argument('--source', required=True, help='Video source (Twitch VOD URL or file path)')
    parser.add_argument('--output-dir', required=True, help='Directory to save screenshots')
    parser.add_argument('--timestamps', default=None, help='Comma-separated timestamps in seconds')
    parser.add_argument('--count', type=int, default=5, help='Number of screenshots if no timestamps given')
    parser.add_argument('--twitch-token', default=None, help='Twitch OAuth token for ad-free access')
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    # Resolve source
    resolved, needs_streamlink = resolve_source(args.source, args.twitch_token)
    if needs_streamlink:
        print(f'[Screenshot] Warning: streamlink pipe mode not supported for screenshots, trying direct URL', file=sys.stderr)

    # Probe resolution
    width, height = probe_resolution(resolved)
    print(f'[Screenshot] Resolution: {width}x{height}', file=sys.stderr)

    # Determine timestamps
    if args.timestamps:
        timestamps = [float(t) for t in args.timestamps.split(',')]
    else:
        # Pick evenly-spaced points, skipping first 30s (title screens)
        duration = probe_duration(resolved)
        # Use first 10 minutes max, skip first 30s
        end = min(duration, 600.0)
        start = min(30.0, end * 0.05)
        step = (end - start) / max(args.count - 1, 1)
        timestamps = [start + i * step for i in range(args.count)]

    # Extract frames
    screenshots = []
    for i, ts in enumerate(timestamps):
        filename = f'frame_{i:03d}_{format_timestamp(ts)}.jpg'
        output_path = os.path.join(args.output_dir, filename)
        print(f'[Screenshot] Extracting frame at {ts:.1f}s...', file=sys.stderr)

        if extract_frame(resolved, ts, output_path, width, height):
            screenshots.append({
                'filename': filename,
                'timestamp': ts,
                'width': width,
                'height': height,
            })
        else:
            print(f'[Screenshot] Failed to extract at {ts:.1f}s', file=sys.stderr)

    # Output manifest
    manifest = {
        'source': args.source,
        'width': width,
        'height': height,
        'screenshots': screenshots,
    }
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
