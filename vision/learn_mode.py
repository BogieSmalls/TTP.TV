"""TTP Vision Learn Mode — Offline VOD processing for detection validation.

Processes a video source (Twitch VOD, local file, or URL) through the
full vision pipeline and generates a detection quality report.

Usage:
    # Standalone with auto-crop:
    python learn_mode.py --source "https://www.twitch.tv/videos/2696354137" \\
        --fps 2 --output report.json

    # With explicit crop:
    python learn_mode.py --source recording.mp4 \\
        --crop 420,60,720,675 --fps 4 --output report.json

    # With server integration (real-time progress + dashboard viewing):
    python learn_mode.py --source "https://www.twitch.tv/videos/2696354137" \\
        --server http://localhost:3000 --session-id abc123 --output report.json
"""

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path

import cv2
import numpy as np
import requests

from detector.nes_state import NesStateDetector, GameState
from detector.temporal_buffer import TemporalBuffer
from detector.game_logic import GameLogicValidator
from detector.auto_crop import (
    AutoCropDetector, CropResult, extract_sample_frames,
    calibrate_from_life_text, find_grid_offset,
)


@dataclass
class FrameResult:
    """Detection result for a single frame."""
    frame_number: int
    video_timestamp: float
    screen_type: str
    raw_screen_type: str          # before temporal smoothing
    hearts_current: int
    hearts_max: int
    rupees: int
    keys: int
    bombs: int
    sword_level: int
    b_item: str | None
    detection_time_ms: float


@dataclass
class DetectorStats:
    """Statistics for a single detector."""
    name: str
    frames_active: int = 0
    value_changes: int = 0
    suspected_errors: int = 0
    values_seen: dict = field(default_factory=dict)


@dataclass
class LearnReport:
    """Complete detection quality report for a learn session."""
    session_id: str
    source: str
    crop: dict
    total_frames: int = 0
    processing_time_s: float = 0.0
    video_duration_s: float = 0.0
    speedup_factor: float = 0.0
    screen_type_counts: dict = field(default_factory=dict)
    area_time_s: dict = field(default_factory=dict)
    screen_transitions: list = field(default_factory=list)
    detector_stats: dict = field(default_factory=dict)
    anomalies: list = field(default_factory=list)
    flicker_events: list = field(default_factory=list)
    snapshots: list = field(default_factory=list)
    total_anomaly_count: int = 0
    calibration: dict = field(default_factory=dict)
    game_events: list = field(default_factory=list)
    triforce_inferred: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def parse_args():
    parser = argparse.ArgumentParser(description='TTP Vision Learn Mode')
    parser.add_argument('--source', required=True,
                        help='Video source (file path, URL, or Twitch VOD URL)')
    parser.add_argument('--crop', default=None,
                        help='Crop region: x,y,w,h (auto-detected if omitted)')
    parser.add_argument('--grid-offset', default=None,
                        help='Grid alignment offset: dx,dy (calibrated from frames if omitted)')
    parser.add_argument('--fps', type=int, default=2,
                        help='Frames per second to process')
    parser.add_argument('--width', type=int, default=1920,
                        help='Source video width')
    parser.add_argument('--height', type=int, default=1080,
                        help='Source video height')
    parser.add_argument('--templates', default='templates',
                        help='Path to template directory')
    parser.add_argument('--temporal-buffer', type=int, default=3,
                        help='Temporal buffer size (1 = no smoothing)')
    parser.add_argument('--server', default=None,
                        help='TTP server URL for progress reporting')
    parser.add_argument('--session-id', default=None,
                        help='Learn session ID (auto-generated if omitted)')
    parser.add_argument('--start-time', default=None,
                        help='Start timestamp (seconds or HH:MM:SS)')
    parser.add_argument('--end-time', default=None,
                        help='End timestamp (seconds or HH:MM:SS)')
    parser.add_argument('--output', default=None,
                        help='Output report JSON file path')
    parser.add_argument('--snapshots-dir', default=None,
                        help='Directory to save frame snapshots (auto-set if --server)')
    parser.add_argument('--snapshot-interval', type=int, default=60,
                        help='Save a snapshot every N seconds of video (default 60)')
    parser.add_argument('--max-snapshots', type=int, default=5000,
                        help='Maximum number of snapshots to save (default 5000)')
    parser.add_argument('--any-roads', default=None,
                        help='Any Roads room positions (comma-separated, e.g. "14,18,74,100")')
    return parser.parse_args()


def post_progress(server: str, session_id: str, progress: dict) -> None:
    """POST progress update to server."""
    try:
        requests.post(
            f'{server}/api/learn/sessions/{session_id}/progress',
            json=progress, timeout=2,
        )
    except requests.RequestException:
        pass  # Don't fail learn session on progress reporting errors


def post_report(server: str, session_id: str, report: dict) -> None:
    """POST final report to server."""
    try:
        requests.post(
            f'{server}/api/learn/sessions/{session_id}/report',
            json=report, timeout=10,
        )
    except requests.RequestException as e:
        print(f'[Learn] Failed to post report: {e}', file=sys.stderr)


def _parse_timestamp(ts: str) -> float:
    """Parse a timestamp string (seconds or HH:MM:SS) to float seconds."""
    try:
        return float(ts)
    except ValueError:
        pass
    parts = ts.split(':')
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    elif len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return float(ts)


def probe_resolution(source: str) -> tuple[int, int] | None:
    """Detect video resolution via ffprobe. Returns (width, height) or None."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height',
             '-of', 'json', source],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            import json as _json
            data = _json.loads(result.stdout)
            streams = data.get('streams', [])
            if streams:
                w = int(streams[0].get('width', 0))
                h = int(streams[0].get('height', 0))
                if w > 0 and h > 0:
                    return w, h
    except Exception as e:
        print(f'[Learn] ffprobe resolution detection failed: {e}', file=sys.stderr)
    return None


def resolve_source(source: str) -> tuple[str, bool]:
    """Resolve Twitch VOD URLs to direct stream URLs for fast seeking."""
    is_twitch = 'twitch.tv' in source
    if not is_twitch:
        return source, False

    print(f'[Learn] Resolving Twitch VOD URL via streamlink...', file=sys.stderr)
    try:
        sl = subprocess.run(
            ['streamlink', source, 'best', '--stream-url'],
            capture_output=True, text=True, timeout=30,
        )
        if sl.returncode == 0 and sl.stdout.strip():
            direct_url = sl.stdout.strip()
            print(f'[Learn] Resolved to direct URL', file=sys.stderr)
            return direct_url, False  # direct URL, no need for streamlink pipe
    except Exception as e:
        print(f'[Learn] streamlink --stream-url failed: {e}, falling back to pipe mode', file=sys.stderr)

    return source, True  # fallback: use streamlink pipe


def main():
    args = parse_args()
    session_id = args.session_id or str(uuid.uuid4())[:8]

    print(f'[Learn] Session {session_id} starting', file=sys.stderr)
    print(f'[Learn] Source: {args.source}', file=sys.stderr)

    # Resolve Twitch VODs to direct URLs for fast seeking
    resolved_source, needs_streamlink = resolve_source(args.source)

    # Auto-detect resolution if using defaults (1920x1080)
    if args.width == 1920 and args.height == 1080:
        detected = probe_resolution(resolved_source)
        if detected and detected != (1920, 1080):
            args.width, args.height = detected
            print(f'[Learn] Auto-detected resolution: {args.width}x{args.height}', file=sys.stderr)
        else:
            print(f'[Learn] Using resolution: {args.width}x{args.height}', file=sys.stderr)

    # ─── Set up snapshots directory ───
    snapshots_dir = args.snapshots_dir
    if not snapshots_dir and args.server:
        # Auto-create in project data directory when running with server
        project_root = Path(__file__).resolve().parent.parent
        snapshots_dir = str(project_root / 'data' / 'learn-snapshots' / session_id)
    if snapshots_dir:
        os.makedirs(snapshots_dir, exist_ok=True)
        print(f'[Learn] Snapshots dir: {snapshots_dir}', file=sys.stderr)
    snapshot_interval = args.snapshot_interval  # seconds of video between interval snapshots

    # ─── Step 1: Auto-crop if not provided ───
    if args.grid_offset:
        _go = [int(v) for v in args.grid_offset.split(',')]
        grid_offset = (_go[0], _go[1])
        life_calibrated = True  # skip frame-based calibration
        print(f'[Learn] Using provided grid offset: {grid_offset}', file=sys.stderr)
    else:
        grid_offset = (1, 2)  # default, will be refined by calibration
        life_calibrated = False

    if args.crop:
        cx, cy, cw, ch = [int(v) for v in args.crop.split(',')]
        crop_result = CropResult(
            x=cx, y=cy, w=cw, h=ch,
            confidence=1.0, aspect_ratio=cw / ch,
            source_width=args.width, source_height=args.height,
            hud_verified=False,
        )
        print(f'[Learn] Using provided crop: {cx},{cy},{cw},{ch}', file=sys.stderr)
    else:
        print('[Learn] Auto-detecting game region...', file=sys.stderr)
        frames = extract_sample_frames(resolved_source, 5, args.width, args.height)
        if not frames:
            print('[Learn] ERROR: Could not extract any frames for auto-crop', file=sys.stderr)
            sys.exit(1)

        print(f'[Learn] Got {len(frames)} sample frames', file=sys.stderr)

        # Try contour-based detection first
        detector = AutoCropDetector()
        crop_result = detector.detect_crop_multi(frames)

        if crop_result is None or crop_result.confidence < 0.3:
            # Fallback: LIFE-text calibration
            print(f'[Learn] Contour detection insufficient (confidence: '
                  f'{crop_result.confidence if crop_result else 0:.2f}), '
                  f'trying LIFE-text calibration...', file=sys.stderr)

            cal = None
            for sample_frame in frames:
                cal = calibrate_from_life_text(sample_frame)
                if cal and cal['confidence'] > 0.5:
                    break

            if cal and cal['confidence'] > 0.5:
                cx, cy, cw, ch = cal['crop']
                grid_offset = cal['grid_offset']
                life_calibrated = True
                crop_result = CropResult(
                    x=cx, y=cy, w=cw, h=ch,
                    confidence=cal['confidence'],
                    aspect_ratio=cw / ch,
                    source_width=args.width, source_height=args.height,
                    hud_verified=True,
                )
                print(f'[Learn] LIFE-text calibration: x={cx} y={cy} w={cw} h={ch} '
                      f'grid_offset={grid_offset} (confidence: {cal["confidence"]:.2f})',
                      file=sys.stderr)
            else:
                print('[Learn] ERROR: Both auto-crop and LIFE-text calibration failed',
                      file=sys.stderr)
                sys.exit(1)
        else:
            cx, cy, cw, ch = crop_result.x, crop_result.y, crop_result.w, crop_result.h
            print(f'[Learn] Auto-crop: x={cx} y={cy} w={cw} h={ch} '
                  f'(confidence: {crop_result.confidence:.2f}, hud_verified: {crop_result.hud_verified})',
                  file=sys.stderr)

    # ─── Step 1b: Calibrate grid offset ───
    if not life_calibrated:
        print('[Learn] Calibrating grid offset...', file=sys.stderr)
        # Extract sample frames if we don't have them yet (manual crop case)
        cal_frames = frames if 'frames' in locals() else extract_sample_frames(
            resolved_source, 3, args.width, args.height)

        offset_found = False
        for sample_frame in cal_frames:
            fh, fw = sample_frame.shape[:2]
            sy1, sy2 = max(0, cy), min(fh, cy + ch)
            sx1, sx2 = max(0, cx), min(fw, cx + cw)
            nes_region = np.zeros((ch, cw, 3), dtype=np.uint8)
            if sy2 > sy1 and sx2 > sx1:
                nes_region[(sy1 - cy):(sy1 - cy) + (sy2 - sy1),
                            (sx1 - cx):(sx1 - cx) + (sx2 - sx1)] = sample_frame[sy1:sy2, sx1:sx2]
            if nes_region.size == 0:
                continue
            canonical = cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)
            detected_offset = find_grid_offset(canonical)
            if detected_offset is not None:
                grid_offset = detected_offset
                print(f'[Learn] Grid offset calibrated: {grid_offset}', file=sys.stderr)
                offset_found = True
                break
        if not offset_found:
            print(f'[Learn] Grid offset: using default {grid_offset}', file=sys.stderr)

    # Report crop to server
    if args.server:
        post_progress(args.server, session_id, {
            'framesProcessed': 0,
            'totalEstimated': 0,
            'percentComplete': 0,
            'cropResult': crop_result.to_dict(),
        })

    # ─── Step 2: Spawn ffmpeg pipeline ───
    frame_size = args.width * args.height * 3
    nes_detector = NesStateDetector(args.templates, grid_offset=grid_offset)

    if args.temporal_buffer > 1:
        buffer = TemporalBuffer(nes_detector, buffer_size=args.temporal_buffer)
    else:
        buffer = None

    any_roads = None
    if args.any_roads:
        any_roads = set(int(x.strip()) for x in args.any_roads.split(','))
        print(f'[Learn] Any Roads rooms: {sorted(any_roads)}', file=sys.stderr)
    validator = GameLogicValidator(any_roads=any_roads)

    # Build ffmpeg seek/trim flags
    ff_pre_input = []   # flags before -i (input seeking — fast)
    ff_post_input = []  # flags after -i (output trim)
    if args.start_time:
        ff_pre_input += ['-ss', str(args.start_time)]
        print(f'[Learn] Starting at {args.start_time}', file=sys.stderr)
    if args.end_time:
        if args.start_time:
            # When -ss is before -i, -to is relative to the decoded output (not absolute)
            # Calculate actual duration: end - start
            start_s = _parse_timestamp(args.start_time)
            end_s = _parse_timestamp(args.end_time)
            if end_s > start_s:
                duration = end_s - start_s
                ff_post_input += ['-t', str(duration)]
                print(f'[Learn] Ending at {args.end_time} (duration: {duration:.0f}s)', file=sys.stderr)
            else:
                ff_post_input += ['-to', str(args.end_time)]
                print(f'[Learn] Ending at {args.end_time}', file=sys.stderr)
        else:
            ff_post_input += ['-to', str(args.end_time)]
            print(f'[Learn] Ending at {args.end_time}', file=sys.stderr)

    # Build ffmpeg command — use resolved URL (direct for Twitch, original for files)
    if needs_streamlink:
        # Fallback: streamlink pipe (only if --stream-url failed)
        sl_proc = subprocess.Popen(
            ['streamlink', args.source, 'best', '-O'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        ffmpeg_proc = subprocess.Popen(
            ['ffmpeg', '-hide_banner', '-loglevel', 'warning']
            + ff_pre_input
            + ['-i', 'pipe:0']
            + ff_post_input
            + ['-vf', f'fps={args.fps}',
               '-pix_fmt', 'bgr24', '-vcodec', 'rawvideo',
               '-f', 'rawvideo', 'pipe:1'],
            stdin=sl_proc.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        sl_proc.stdout.close()
    else:
        sl_proc = None
        ffmpeg_proc = subprocess.Popen(
            ['ffmpeg', '-hide_banner', '-loglevel', 'warning']
            + ff_pre_input
            + ['-i', resolved_source]
            + ff_post_input
            + ['-vf', f'fps={args.fps}',
               '-pix_fmt', 'bgr24', '-vcodec', 'rawvideo',
               '-f', 'rawvideo', 'pipe:1'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )

    # ─── Step 3: Process frames ───
    print(f'[Learn] Processing at {args.fps} fps...', file=sys.stderr)
    start_time = time.time()
    frame_count = 0
    prev_screen_type = None
    screen_type_counts: dict[str, int] = {}
    screen_transitions: list[tuple[float, str, str]] = []
    frame_results: list[dict] = []
    area_time: dict[str, float] = {}  # area label → seconds of video time

    # Track per-field value changes for detector stats
    prev_values: dict[str, object] = {}
    value_change_counts: dict[str, int] = {}
    values_seen: dict[str, dict] = {}

    SUBSCREEN_ONLY_FIELDS = {'items', 'triforce'}

    # Snapshot tracking
    snapshots_saved: list[dict] = []
    last_snapshot_ts = -999.0  # last video timestamp we saved a snapshot
    snapshot_count = 0
    MAX_SNAPSHOTS = args.max_snapshots

    def save_snapshot(nes_frame: np.ndarray, full_frame: np.ndarray,
                      reason: str, video_ts: float, frame_num: int,
                      state_dict: dict | None = None, extra: str = '') -> None:
        nonlocal snapshot_count
        if not snapshots_dir or snapshot_count >= MAX_SNAPSHOTS:
            return
        snapshot_count += 1
        ts_str = f'{int(video_ts // 60):02d}m{int(video_ts % 60):02d}s'
        fname = f'{snapshot_count:04d}_{reason}_{ts_str}.jpg'
        path = os.path.join(snapshots_dir, fname)
        # Save the cropped NES region (256x240 upscaled for visibility)
        display = cv2.resize(nes_frame, (512, 480), interpolation=cv2.INTER_NEAREST)
        cv2.imwrite(path, display, [cv2.IMWRITE_JPEG_QUALITY, 85])
        snap_info = {
            'filename': fname,
            'reason': reason,
            'frame': frame_num,
            'videoTimestamp': round(video_ts, 2),
            'screenType': state_dict.get('screen_type', '') if state_dict else '',
            'dungeonLevel': state_dict.get('dungeon_level', 0) if state_dict else 0,
            'hasMasterKey': state_dict.get('has_master_key', False) if state_dict else False,
            'gannonNearby': state_dict.get('gannon_nearby', False) if state_dict else False,
            'mapPosition': state_dict.get('map_position', 0) if state_dict else 0,
            'swordLevel': state_dict.get('sword_level', 0) if state_dict else 0,
            'bItem': state_dict.get('b_item', '') if state_dict else '',
            'heartsCurrent': state_dict.get('hearts_current', 0) if state_dict else 0,
            'heartsMax': state_dict.get('hearts_max', 3) if state_dict else 3,
            'rupees': state_dict.get('rupees', 0) if state_dict else 0,
            'keys': state_dict.get('keys', 0) if state_dict else 0,
            'bombs': state_dict.get('bombs', 0) if state_dict else 0,
            'bombMax': state_dict.get('bomb_max', 8) if state_dict else 8,
            'items': state_dict.get('items', {}) if state_dict else {},
            'triforce': state_dict.get('triforce', [False]*8) if state_dict else [False]*8,
            'extra': extra,
        }
        snapshots_saved.append(snap_info)

    while True:
        raw = ffmpeg_proc.stdout.read(frame_size)
        if len(raw) < frame_size:
            break

        t0 = time.time()
        frame = np.frombuffer(raw, dtype=np.uint8).reshape((args.height, args.width, 3))

        # Crop to NES game area (pad with black if crop extends outside frame boundaries)
        fh, fw = frame.shape[:2]
        sy1, sy2 = max(0, cy), min(fh, cy + ch)
        sx1, sx2 = max(0, cx), min(fw, cx + cw)
        nes_region = np.zeros((ch, cw, 3), dtype=np.uint8)
        if sy2 > sy1 and sx2 > sx1:
            nes_region[(sy1 - cy):(sy1 - cy) + (sy2 - sy1),
                        (sx1 - cx):(sx1 - cx) + (sx2 - sx1)] = frame[sy1:sy2, sx1:sx2]
        nes_canonical = cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)

        # Detect with optional temporal smoothing
        if buffer:
            raw_state, stable_state = buffer.get_raw_and_stable(nes_canonical)
        else:
            raw_state = nes_detector.detect(nes_canonical)
            stable_state = raw_state

        # Apply game logic validation
        validated = validator.validate(stable_state, frame_count)

        detection_ms = (time.time() - t0) * 1000
        video_ts = frame_count / args.fps

        # Track screen type
        st = validated.screen_type
        screen_type_counts[st] = screen_type_counts.get(st, 0) + 1

        # Track time per area (overworld, dungeon_1..9, cave, subscreen, etc.)
        seconds_per_frame = 1.0 / args.fps
        if st == 'dungeon' and validated.dungeon_level > 0:
            area_label = f'dungeon_{validated.dungeon_level}'
        else:
            area_label = st
        area_time[area_label] = area_time.get(area_label, 0.0) + seconds_per_frame

        if prev_screen_type is not None and st != prev_screen_type:
            screen_transitions.append((video_ts, prev_screen_type, st))
        prev_screen_type = st

        # Track per-field changes
        state_dict = validated.to_dict()

        # For subscreen frames, use RAW detection values for subscreen-only
        # fields (items, triforce).  These fields are only read when
        # screen_type == 'subscreen', but the temporal buffer requires 3+
        # consecutive identical values before stabilising.  Subscreens are
        # too brief for that, so raw values are more accurate here.
        if st == 'subscreen' and buffer:
            raw_dict = raw_state.to_dict()
            for field in SUBSCREEN_ONLY_FIELDS:
                if field in raw_dict:
                    state_dict[field] = raw_dict[field]

        # Z1R: substitute accumulated inventory when subscreen reader returns {}
        if not state_dict.get('items'):
            accumulated = validator.get_accumulated_inventory()
            if any(accumulated.values()):
                state_dict['items'] = accumulated

        for key, value in state_dict.items():
            if key in SUBSCREEN_ONLY_FIELDS and st != 'subscreen':
                continue
            str_val = str(value)
            if key not in values_seen:
                values_seen[key] = {}
            values_seen[key][str_val] = values_seen[key].get(str_val, 0) + 1

            if key in prev_values and prev_values[key] != value:
                value_change_counts[key] = value_change_counts.get(key, 0) + 1
            prev_values[key] = value

        # ─── Snapshot triggers ───
        if snapshots_dir:
            is_transition = prev_screen_type is not None and len(screen_transitions) > 0 and screen_transitions[-1][0] == video_ts
            # Save at screen transitions
            if is_transition:
                from_st, to_st = screen_transitions[-1][1], screen_transitions[-1][2]
                save_snapshot(nes_canonical, frame, 'transition', video_ts, frame_count,
                              state_dict, f'{from_st} → {to_st}')
            # Save at regular intervals
            elif video_ts - last_snapshot_ts >= snapshot_interval:
                save_snapshot(nes_canonical, frame, 'interval', video_ts, frame_count, state_dict)
                last_snapshot_ts = video_ts

        frame_count += 1

        # Progress reporting
        if frame_count % 100 == 0:
            elapsed = time.time() - start_time
            fps_actual = frame_count / elapsed if elapsed > 0 else 0
            print(f'[Learn] {frame_count} frames, {fps_actual:.1f} fps, '
                  f'screen: {st}, detection: {detection_ms:.1f}ms', file=sys.stderr)

            if args.server:
                post_progress(args.server, session_id, {
                    'framesProcessed': frame_count,
                    'totalEstimated': 0,  # We don't know total yet
                    'percentComplete': 0,
                    'currentScreenType': st,
                })

    # ─── Step 4: Cleanup ───
    ffmpeg_proc.wait()
    if sl_proc:
        sl_proc.terminate()

    processing_time = time.time() - start_time
    video_duration = frame_count / args.fps if args.fps > 0 else 0

    print(f'[Learn] Done: {frame_count} frames in {processing_time:.1f}s '
          f'({video_duration:.1f}s of video)', file=sys.stderr)

    # ─── Step 5: Build report ───
    # Detect flicker events (rapid back-and-forth transitions)
    flicker_events = []
    for i in range(1, len(screen_transitions) - 1):
        ts_prev, from_prev, to_prev = screen_transitions[i - 1]
        ts_curr, from_curr, to_curr = screen_transitions[i]
        # If we transitioned A->B->A within 2 seconds, it's likely a flicker
        if to_prev == from_curr and from_prev == to_curr:
            if ts_curr - ts_prev < 2.0:
                flicker_events.append({
                    'timestamp': ts_curr,
                    'sequence': f'{from_prev} -> {to_prev} -> {to_curr}',
                    'duration': ts_curr - ts_prev,
                })

    # Build detector stats
    detector_stats = {}
    for key, change_count in value_change_counts.items():
        detector_stats[key] = {
            'name': key,
            'value_changes': change_count,
            'values_seen': values_seen.get(key, {}),
        }

    if snapshots_dir:
        print(f'[Learn] Saved {len(snapshots_saved)} snapshots to {snapshots_dir}', file=sys.stderr)

    # ─── Step 5b: Auto-calibrate overworld map positions ───
    from detector.room_matcher import calibrate_positions
    project_root = Path(__file__).resolve().parent.parent
    room_tiles_dir = str(project_root / 'content' / 'overworld_rooms')

    calibration = None
    if snapshots_dir and os.path.isdir(room_tiles_dir):
        print('[Learn] Running map position calibration...', file=sys.stderr)
        calibration = calibrate_positions(snapshots_saved, snapshots_dir, room_tiles_dir)
        if calibration and calibration['applied']:
            print(f'[Learn] Calibration: col {calibration["offset_col"]:+d}, '
                  f'row {calibration["offset_row"]:+d} '
                  f'(dungeon col {calibration["offset_col_dungeon"]:+d}) '
                  f'— {calibration["confidence"]:.0%} confidence, '
                  f'{calibration["samples"]} samples', file=sys.stderr)
        elif calibration:
            print(f'[Learn] Calibration: no offset needed '
                  f'({calibration["confidence"]:.0%} confidence, '
                  f'{calibration["samples"]} samples)', file=sys.stderr)
        else:
            print('[Learn] Calibration: insufficient data', file=sys.stderr)

    # ─── Step 5c: Post-filter anomalies after calibration ───
    # Anomalies are generated during frame processing with uncorrected positions.
    # After calibration/refinement, many position-based anomalies are explained
    # by the systematic offset or per-snapshot corrections. Remove those, and
    # downgrade Up+A/staircase warps from warnings to info.
    all_anomalies = validator.get_anomalies()
    pre_filter_count = len(all_anomalies)

    # Remove position anomalies that were caused by uncorrected map readings:
    # - "Non-adjacent overworld jump" anomalies are likely due to minimap lag
    #   that calibration/refinement now corrects
    # - Keep Up+A/Reset and staircase anomalies (they're real events, just info-severity)
    filtered_anomalies = []
    position_removed = 0
    for a in all_anomalies:
        if a['detector'] == 'map_position':
            desc = a.get('description', '')
            # Keep gameplay events as informational
            if any(k in desc for k in ('Up+A', 'Reset', 'staircase', 'Any Roads', 'Cave warp')):
                a['severity'] = 'info'
                filtered_anomalies.append(a)
            elif calibration and calibration.get('applied'):
                # Position was corrected by calibration — this anomaly is stale
                position_removed += 1
            else:
                filtered_anomalies.append(a)
        else:
            filtered_anomalies.append(a)

    if position_removed > 0:
        print(f'[Learn] Removed {position_removed} stale position anomalies '
              f'(corrected by calibration)', file=sys.stderr)

    total_anomaly_count = len(filtered_anomalies)
    anomalies = filtered_anomalies[:1000]
    for a in anomalies:
        a['timestamp'] = a['frame'] / args.fps if args.fps > 0 else 0
    if total_anomaly_count > 1000:
        print(f'[Learn] Capped anomalies in report: {total_anomaly_count} total, 1000 included',
              file=sys.stderr)

    report = LearnReport(
        session_id=session_id,
        source=args.source,
        crop=crop_result.to_dict(),
        total_frames=frame_count,
        processing_time_s=round(processing_time, 2),
        video_duration_s=round(video_duration, 2),
        speedup_factor=round(video_duration / processing_time, 2) if processing_time > 0 else 0,
        screen_type_counts=screen_type_counts,
        area_time_s={k: round(v, 1) for k, v in sorted(area_time.items())},
        screen_transitions=[(ts, f, t) for ts, f, t in screen_transitions],
        detector_stats=detector_stats,
        anomalies=anomalies,
        flicker_events=flicker_events,
        snapshots=snapshots_saved,
        total_anomaly_count=total_anomaly_count,
        calibration={**(calibration or {}), 'pixel_dx': grid_offset[0], 'pixel_dy': grid_offset[1]},
        game_events=validator.game_events,
        triforce_inferred=validator.get_triforce_inferred(),
    )

    # ─── Step 6: Output ───
    report_dict = report.to_dict()

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(report_dict, f, indent=2)
        print(f'[Learn] Report written to {args.output}', file=sys.stderr)

    if args.server:
        post_report(args.server, session_id, report_dict)
        print(f'[Learn] Report posted to server', file=sys.stderr)

    # Print summary
    print(f'\n=== Learn Mode Report ===', file=sys.stderr)
    print(f'Frames: {frame_count}', file=sys.stderr)
    print(f'Duration: {video_duration:.0f}s video in {processing_time:.1f}s ({report.speedup_factor:.1f}x)',
          file=sys.stderr)
    print(f'Screen types: {screen_type_counts}', file=sys.stderr)
    print(f'Transitions: {len(screen_transitions)}', file=sys.stderr)
    print(f'Anomalies: {total_anomaly_count}', file=sys.stderr)
    print(f'Flicker events: {len(flicker_events)}', file=sys.stderr)
    print(f'Snapshots: {len(snapshots_saved)}', file=sys.stderr)

    # Game event summary
    ge = validator.game_events
    deaths = [e for e in ge if e['event'] == 'death']
    warps = [e for e in ge if e['event'] == 'up_a_warp']
    triforces = [e for e in ge if e['event'] == 'triforce_inferred']
    completions = [e for e in ge if e['event'] == 'game_complete']
    hearts = [e for e in ge if e['event'] == 'heart_container']
    ganon_fights = [e for e in ge if e['event'] == 'ganon_fight']
    ganon_kills = [e for e in ge if e['event'] == 'ganon_kill']
    print(f'Game events: {len(deaths)} deaths, {len(warps)} Up+A warps, '
          f'{len(triforces)} triforce inferred, {len(hearts)} heart containers, '
          f'{len(ganon_fights)} ganon fights, {len(ganon_kills)} ganon kills, '
          f'{len(completions)} game completions', file=sys.stderr)
    if triforces:
        ti = validator.get_triforce_inferred()
        pieces = [i + 1 for i, v in enumerate(ti) if v]
        print(f'Triforce inferred: pieces {pieces}', file=sys.stderr)

    # Also print JSON to stdout for piping
    if not args.output:
        print(json.dumps(report_dict, indent=2))


if __name__ == '__main__':
    main()
