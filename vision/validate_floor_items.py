"""Floor Item Detection — Real-Capture Validation.

Processes existing learn-session snapshots (512x480 JPEGs from real Twitch
captures) through FloorItemDetector to validate:
1. Does the 0.75 threshold hold on compressed video?
2. What false positives appear from Link, enemies, walls?
3. Score distribution of real detections vs synthetic baseline

Usage:
    python validate_floor_items.py --session 064eb5b2
    python validate_floor_items.py --session 064eb5b2 --save-debug
"""

import argparse
import json
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np

from detector.item_reader import ItemReader
from detector.floor_item_detector import FloorItemDetector
from detector.screen_classifier import ScreenClassifier
from detector.auto_crop import find_grid_alignment
from detector.nes_frame import NESFrame

# Thresholds to test
THRESHOLDS = [0.65, 0.70, 0.75, 0.80]


def load_snapshot_metadata(session_id: str) -> list[dict]:
    """Load snapshot metadata from the session report."""
    report_path = Path(f'../data/report_{session_id}.json')
    if not report_path.exists():
        # Try without prefix
        for p in Path('../data').glob(f'report*{session_id}*.json'):
            report_path = p
            break
    if not report_path.exists():
        print(f'Report not found for session {session_id}', file=sys.stderr)
        sys.exit(1)
    with open(report_path) as f:
        report = json.load(f)
    return report.get('snapshots', [])


def main():
    parser = argparse.ArgumentParser(description='Floor item detection validation')
    parser.add_argument('--session', default='064eb5b2',
                        help='Session ID (default: 064eb5b2)')
    parser.add_argument('--save-debug', action='store_true',
                        help='Save annotated debug images')
    parser.add_argument('--max-frames', type=int, default=0,
                        help='Max frames to process (0 = all)')
    parser.add_argument('--screen-types', default='dungeon,overworld',
                        help='Screen types to process (comma-separated)')
    args = parser.parse_args()

    snap_dir = Path(f'../data/learn-snapshots/{args.session}')
    if not snap_dir.exists():
        print(f'Snapshot dir not found: {snap_dir}', file=sys.stderr)
        sys.exit(1)

    debug_dir = Path('../debug_floor_validation')
    if args.save_debug:
        debug_dir.mkdir(exist_ok=True)

    # Load metadata for screen type filtering
    snapshots = load_snapshot_metadata(args.session)
    target_types = set(args.screen_types.split(','))
    print(f'Loaded {len(snapshots)} snapshot metadata entries')
    print(f'Filtering for screen types: {target_types}')

    # Filter to gameplay snapshots
    gameplay_snaps = [s for s in snapshots if s['screenType'] in target_types]
    if args.max_frames:
        gameplay_snaps = gameplay_snaps[:args.max_frames]
    print(f'Processing {len(gameplay_snaps)} gameplay snapshots')

    # Init detector
    item_reader = ItemReader('templates/items')
    print(f'Loaded {len(item_reader.templates)} item templates')

    # Run detection at multiple thresholds
    results_by_threshold = {}
    for threshold in THRESHOLDS:
        detector = FloorItemDetector(item_reader, score_threshold=threshold)
        results = run_detection(detector, gameplay_snaps, snap_dir, threshold,
                                args.save_debug, debug_dir)
        results_by_threshold[threshold] = results

    # Print comparison table
    print_results(results_by_threshold, len(gameplay_snaps))

    # Detailed analysis at 0.75 (our current threshold)
    print_detailed(results_by_threshold[0.75])

    # Save full results as JSON
    out_path = Path(f'../data/floor_validation_{args.session}.json')
    save_results(results_by_threshold, out_path)
    print(f'\nFull results saved to {out_path}')


def run_detection(detector: FloorItemDetector, snaps: list[dict],
                  snap_dir: Path, threshold: float,
                  save_debug: bool, debug_dir: Path) -> dict:
    """Run floor detection on all snapshots at a given threshold."""
    all_detections = []       # (snap_info, FloorItem_dict)
    frames_with_items = 0
    total_items = 0
    score_list = []
    item_counts = Counter()
    items_by_screen = defaultdict(list)
    process_times = []

    for i, snap in enumerate(snaps):
        fname = snap['filename']
        img_path = snap_dir / fname
        if not img_path.exists():
            continue

        # Load and resize to canonical 256x240
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        frame = cv2.resize(img, (256, 240), interpolation=cv2.INTER_NEAREST)
        nf = NESFrame(frame, 1.0, 1.0)

        screen_type = snap['screenType']

        t0 = time.perf_counter()
        items = detector.detect(nf, screen_type)
        dt = (time.perf_counter() - t0) * 1000
        process_times.append(dt)

        if items:
            frames_with_items += 1
            total_items += len(items)
            for item in items:
                d = {'name': item.name, 'x': item.x, 'y': item.y,
                     'score': item.score}
                all_detections.append((snap, d))
                score_list.append(item.score)
                item_counts[item.name] += 1
                items_by_screen[screen_type].append(d)

            # Save debug image
            if save_debug and threshold == 0.75:
                debug_img = frame.copy()
                for item in items:
                    cv2.rectangle(debug_img, (item.x, item.y),
                                  (item.x + 8, item.y + 16),
                                  (0, 255, 0), 1)
                    label = f'{item.name} {item.score:.2f}'
                    cv2.putText(debug_img, label, (item.x, item.y - 2),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.25,
                                (0, 255, 0), 1)
                # Scale up for visibility
                debug_img = cv2.resize(debug_img, (512, 480),
                                       interpolation=cv2.INTER_NEAREST)
                ts = snap.get('videoTimestamp', 0)
                m, s = int(ts // 60), int(ts % 60)
                out_name = f'{fname[:-4]}_floor_{m:02d}m{s:02d}s.png'
                cv2.imwrite(str(debug_dir / out_name), debug_img)

        if (i + 1) % 500 == 0:
            print(f'  [{threshold:.2f}] {i+1}/{len(snaps)} processed, '
                  f'{frames_with_items} frames with items, '
                  f'{total_items} total detections', file=sys.stderr)

    return {
        'threshold': threshold,
        'frames_processed': len(snaps),
        'frames_with_items': frames_with_items,
        'total_items': total_items,
        'items_per_frame': total_items / max(len(snaps), 1),
        'scores': score_list,
        'item_counts': dict(item_counts.most_common()),
        'items_by_screen': {k: v for k, v in items_by_screen.items()},
        'detections': all_detections,
        'avg_time_ms': sum(process_times) / max(len(process_times), 1),
    }


def print_results(results: dict, total_frames: int):
    """Print comparison table across thresholds."""
    print('\n' + '=' * 70)
    print('FLOOR ITEM DETECTION — REAL CAPTURE VALIDATION')
    print('=' * 70)
    print(f'Total gameplay frames: {total_frames}')
    print()

    header = f'{"Threshold":>10} | {"Frames w/items":>15} | {"Total items":>12} | {"Items/frame":>11} | {"Avg ms":>8}'
    print(header)
    print('-' * len(header))
    for t in THRESHOLDS:
        r = results[t]
        print(f'{t:>10.2f} | {r["frames_with_items"]:>15} | '
              f'{r["total_items"]:>12} | {r["items_per_frame"]:>11.3f} | '
              f'{r["avg_time_ms"]:>8.1f}')

    print()


def print_detailed(result: dict):
    """Print detailed analysis for a single threshold."""
    print('--- Detailed analysis at threshold 0.75 ---')
    print()

    # Score distribution
    scores = result['scores']
    if scores:
        bins = [(0.75, 0.80), (0.80, 0.85), (0.85, 0.90),
                (0.90, 0.95), (0.95, 1.01)]
        print('Score distribution:')
        for lo, hi in bins:
            count = sum(1 for s in scores if lo <= s < hi)
            bar = '#' * min(count, 60)
            print(f'  {lo:.2f}-{hi:.2f}: {count:>5} {bar}')
        print(f'  Min: {min(scores):.3f}  Max: {max(scores):.3f}  '
              f'Mean: {sum(scores)/len(scores):.3f}')
    else:
        print('  No detections at this threshold.')

    print()

    # Item breakdown
    print('Items detected:')
    for name, count in sorted(result['item_counts'].items(),
                               key=lambda x: x[1], reverse=True):
        print(f'  {name:>25}: {count}')

    print()

    # Per screen type
    print('Detections by screen type:')
    for st, items in result['items_by_screen'].items():
        scores_st = [d['score'] for d in items]
        print(f'  {st}: {len(items)} detections, '
              f'mean score {sum(scores_st)/len(scores_st):.3f}')

    # Look for suspicious patterns (same item appearing in many frames
    # at similar positions = likely false positive from static background)
    print()
    print('Potential false positive patterns (items appearing >10 times):')
    detections = result['detections']
    # Group by item name and approximate position
    pos_groups = defaultdict(list)
    for snap, det in detections:
        key = (det['name'], det['x'] // 16, det['y'] // 16)
        pos_groups[key].append((snap, det))

    suspicious = [(k, v) for k, v in pos_groups.items() if len(v) > 10]
    suspicious.sort(key=lambda x: len(x[1]), reverse=True)
    if suspicious:
        for (name, gx, gy), items in suspicious[:20]:
            timestamps = [s.get('videoTimestamp', 0) for s, _ in items]
            t_min, t_max = min(timestamps), max(timestamps)
            m1, s1 = int(t_min // 60), int(t_min % 60)
            m2, s2 = int(t_max // 60), int(t_max % 60)
            avg_score = sum(d['score'] for _, d in items) / len(items)
            print(f'  {name:>20} at ~({gx*16},{gy*16}): {len(items)}x, '
                  f'score {avg_score:.3f}, '
                  f'{m1:02d}:{s1:02d}-{m2:02d}:{s2:02d}')
    else:
        print('  None found.')

    print()


def save_results(results: dict, path: Path):
    """Save results as JSON (without raw detections for size)."""
    out = {}
    for t, r in results.items():
        out[str(t)] = {
            'threshold': r['threshold'],
            'frames_processed': r['frames_processed'],
            'frames_with_items': r['frames_with_items'],
            'total_items': r['total_items'],
            'items_per_frame': r['items_per_frame'],
            'score_stats': {
                'min': min(r['scores']) if r['scores'] else None,
                'max': max(r['scores']) if r['scores'] else None,
                'mean': sum(r['scores']) / len(r['scores']) if r['scores'] else None,
                'count': len(r['scores']),
            },
            'item_counts': r['item_counts'],
            'avg_time_ms': r['avg_time_ms'],
        }
    with open(path, 'w') as f:
        json.dump(out, f, indent=2)


if __name__ == '__main__':
    main()
