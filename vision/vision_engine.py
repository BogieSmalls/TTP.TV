"""TTP Vision Engine — Main entry point.

Reads raw video frames from stdin (piped from ffmpeg), runs NES game state
detection, and pushes state updates to the TTP server via HTTP POST.

Usage:
    ffmpeg -i rtmp://localhost:1935/live/racer1 -vf "fps=2" \
        -pix_fmt bgr24 -vcodec rawvideo -f rawvideo pipe:1 \
        | python vision_engine.py --racer racer1 \
            --crop 100,50,720,540 --server http://localhost:3000

Args:
    --racer: Racer ID (used in API endpoint)
    --crop: Crop region in the source frame: x,y,w,h
    --server: TTP server base URL
    --width: Source frame width (default: 1920)
    --height: Source frame height (default: 1080)
"""

import argparse
import sys
import time

import cv2
import numpy as np
import requests

from detector.nes_state import NesStateDetector, GameState
from detector.auto_crop import find_grid_alignment, calibrate_from_life_text
from detector.game_logic import GameLogicValidator


def parse_args():
    parser = argparse.ArgumentParser(description='TTP Vision Engine')
    parser.add_argument('--racer', required=True, help='Racer ID')
    parser.add_argument('--crop', default='0,0,1920,1080',
                        help='Crop region: x,y,w,h')
    parser.add_argument('--server', default='http://localhost:3000',
                        help='TTP server URL')
    parser.add_argument('--width', type=int, default=1920,
                        help='Source frame width')
    parser.add_argument('--height', type=int, default=1080,
                        help='Source frame height')
    parser.add_argument('--templates', default='templates',
                        help='Path to template directory')
    parser.add_argument('--grid-offset', default='0,0',
                        help='Grid alignment offset: dx,dy')
    parser.add_argument('--landmarks', default=None,
                        help='JSON array of landmark positions from crop profile')
    parser.add_argument('--crop-profile-id', default=None,
                        help='Crop profile ID — calibrated grid offset is written back to server')
    return parser.parse_args()


def main():
    args = parse_args()
    crop = [int(v) for v in args.crop.split(',')]
    crop_x, crop_y, crop_w, crop_h = crop
    grid_offset = [int(v) for v in args.grid_offset.split(',')]
    grid_dx, grid_dy = grid_offset

    frame_size = args.width * args.height * 3  # BGR24
    api_url = f'{args.server}/api/vision/{args.racer}'

    merged_state = {}   # Accumulated state across frames (persists inventory/triforce)
    prev_sent = {}      # Last state dict sent to server (for delta comparison)
    frame_count = 0
    start_time = time.time()

    # Live frame preview — overwritten on every tick, served by the dashboard
    import os as _os_live
    _data_dir = _os_live.path.join(_os_live.path.dirname(_os_live.path.abspath(__file__)), '..', 'data')
    _os_live.makedirs(_data_dir, exist_ok=True)
    frame_out_path = _os_live.path.join(_data_dir, f'vision-frame-{args.racer}.jpg')

    # Fields that should only update when on the subscreen
    SUBSCREEN_ONLY_FIELDS = {'items', 'triforce'}

    print(f'[Vision] Starting for racer {args.racer}', file=sys.stderr)
    print(f'[Vision] Frame size: {args.width}x{args.height} ({frame_size} bytes)',
          file=sys.stderr)
    print(f'[Vision] Crop: x={crop_x} y={crop_y} w={crop_w} h={crop_h}',
          file=sys.stderr)
    print(f'[Vision] Grid offset (from profile): dx={grid_dx} dy={grid_dy}',
          file=sys.stderr)

    # ── Calibration from landmarks or auto-detect ──
    life_row = 5  # standard row
    calibrated = (grid_dx != 0 or grid_dy != 0)

    # Parse landmarks from crop profile (if provided)
    landmarks = None
    if args.landmarks:
        import json as _json_mod
        try:
            landmarks = _json_mod.loads(args.landmarks)
            print(f'[Vision] Landmarks provided: {len(landmarks)} elements', file=sys.stderr)
        except Exception as e:
            print(f'[Vision] Failed to parse landmarks: {e}', file=sys.stderr)

    # Derive grid offset from LIFE landmark position
    if landmarks and not calibrated:
        life_lm = next((lm for lm in landmarks if '-LIFE-' in lm.get('label', '')), None)
        if life_lm:
            lx, ly = life_lm['x'], life_lm['y']
            grid_dx = lx % 8
            grid_dy = ly % 8
            life_row = ly // 8
            calibrated = True
            print(f'[Vision] Calibrated from LIFE landmark at ({lx},{ly}): '
                  f'dx={grid_dx} dy={grid_dy} life_row={life_row}', file=sys.stderr)

    # Sub-crop: when the initial crop is too loose, calibrate_from_life_text
    # detects the actual NES game boundaries within the cropped region.
    sub_crop = None  # (sx, sy, sw, sh) relative to nes_region, or None

    if calibrated:
        print(f'[Vision] Using grid offset dx={grid_dx} dy={grid_dy} life_row={life_row}',
              file=sys.stderr)
    else:
        print('[Vision] No landmarks or grid offset — will auto-calibrate from gameplay frames',
              file=sys.stderr)

    # Create initial detector (may be re-created after calibration)
    detector = NesStateDetector(args.templates, grid_offset=(grid_dx, grid_dy),
                                life_row=life_row, landmarks=landmarks)

    # Game logic validator — tracks state continuously across calibration changes
    validator = GameLogicValidator()

    print(f'[Vision] Digit templates loaded: {detector.digit_reader.has_templates()} '
          f'({len(detector.digit_reader.templates)} digits)', file=sys.stderr)

    diag_done = False
    def run_diagnostics(frame):
        nonlocal diag_done
        if diag_done:
            return
        diag_done = True

        import json as _json
        import os as _os
        diag = {}

        hud = detector.hud_reader
        dx, dy = hud.grid_dx, hud.grid_dy
        diag['grid_offset'] = {'dx': dx, 'dy': dy}
        diag['life_row'] = life_row
        diag['templates_loaded'] = len(detector.digit_reader.templates)
        if sub_crop:
            diag['sub_crop'] = {'x': sub_crop[0], 'y': sub_crop[1],
                                'w': sub_crop[2], 'h': sub_crop[3]}

        # LIFE text tile
        life_tile = hud._tile(frame, hud.LIFE_TEXT_START_COL, hud.LIFE_TEXT_ROW)
        life_avg = np.mean(life_tile, axis=(0, 1))
        diag['life_tile'] = {'bgr': [round(float(life_avg[i])) for i in range(3)],
                             'pos': [hud.LIFE_TEXT_START_COL * 8 + dx, hud.LIFE_TEXT_ROW * 8 + dy]}

        # Rupee digit tiles
        diag['rupee_digits'] = []
        for col in hud.RUPEE_DIGIT_COLS:
            tile = hud._tile(frame, col, hud.RUPEE_DIGIT_ROW)
            tile_gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
            brightness = float(np.mean(tile))
            best_score, best_digit = 0.0, -1
            all_scores = {}
            for d in detector.digit_reader.templates:
                tmpl_gray = detector.digit_reader.template_grays[d]
                result = cv2.matchTemplate(tile_gray, tmpl_gray, cv2.TM_CCOEFF_NORMED)
                score = float(result[0][0])
                all_scores[str(d)] = round(score, 3)
                if score > best_score:
                    best_score, best_digit = score, d
            diag['rupee_digits'].append({
                'col': col, 'row': hud.RUPEE_DIGIT_ROW,
                'pos': [col * 8 + dx, hud.RUPEE_DIGIT_ROW * 8 + dy],
                'brightness': round(brightness, 1),
                'best_digit': best_digit, 'best_score': round(best_score, 3),
                'all_scores': all_scores,
            })

        # Key digit
        tile = hud._tile(frame, hud.KEY_DIGIT_COLS[0], hud.KEY_DIGIT_ROW)
        tile_gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
        brightness = float(np.mean(tile))
        best_score, best_digit = 0.0, -1
        all_scores = {}
        for d in detector.digit_reader.templates:
            tmpl_gray = detector.digit_reader.template_grays[d]
            result = cv2.matchTemplate(tile_gray, tmpl_gray, cv2.TM_CCOEFF_NORMED)
            score = float(result[0][0])
            all_scores[str(d)] = round(score, 3)
            if score > best_score:
                best_score, best_digit = score, d
        diag['key_digit'] = {
            'col': hud.KEY_DIGIT_COLS[0], 'row': hud.KEY_DIGIT_ROW,
            'pos': [hud.KEY_DIGIT_COLS[0] * 8 + dx, hud.KEY_DIGIT_ROW * 8 + dy],
            'brightness': round(brightness, 1),
            'best_digit': best_digit, 'best_score': round(best_score, 3),
            'all_scores': all_scores,
        }

        # Bomb digit
        tile = hud._tile(frame, hud.BOMB_DIGIT_COLS[0], hud.BOMB_DIGIT_ROW)
        tile_gray = cv2.cvtColor(tile, cv2.COLOR_BGR2GRAY)
        brightness = float(np.mean(tile))
        best_score, best_digit = 0.0, -1
        all_scores = {}
        for d in detector.digit_reader.templates:
            tmpl_gray = detector.digit_reader.template_grays[d]
            result = cv2.matchTemplate(tile_gray, tmpl_gray, cv2.TM_CCOEFF_NORMED)
            score = float(result[0][0])
            all_scores[str(d)] = round(score, 3)
            if score > best_score:
                best_score, best_digit = score, d
        diag['bomb_digit'] = {
            'col': hud.BOMB_DIGIT_COLS[0], 'row': hud.BOMB_DIGIT_ROW,
            'pos': [hud.BOMB_DIGIT_COLS[0] * 8 + dx, hud.BOMB_DIGIT_ROW * 8 + dy],
            'brightness': round(brightness, 1),
            'best_digit': best_digit, 'best_score': round(best_score, 3),
            'all_scores': all_scores,
        }

        # Level digit
        lvl_tile = hud._tile(frame, hud.LEVEL_DIGIT_COL, hud.LEVEL_DIGIT_ROW)
        lvl_gray = cv2.cvtColor(lvl_tile, cv2.COLOR_BGR2GRAY)
        lvl_brightness = float(np.mean(lvl_tile))
        best_score, best_digit = 0.0, -1
        for d in detector.digit_reader.templates:
            tmpl_gray = detector.digit_reader.template_grays[d]
            result = cv2.matchTemplate(lvl_gray, tmpl_gray, cv2.TM_CCOEFF_NORMED)
            score = float(result[0][0])
            if score > best_score:
                best_score, best_digit = score, d
        diag['level_digit'] = {
            'col': hud.LEVEL_DIGIT_COL, 'row': hud.LEVEL_DIGIT_ROW,
            'pos': [hud.LEVEL_DIGIT_COL * 8 + dx, hud.LEVEL_DIGIT_ROW * 8 + dy],
            'brightness': round(lvl_brightness, 1),
            'best_digit': best_digit, 'best_score': round(best_score, 3),
        }

        # Save the canonical frame for inspection
        diag_dir = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', 'data')
        _os.makedirs(diag_dir, exist_ok=True)
        diag_path = _os.path.join(diag_dir, f'vision-diag-{args.racer[:8]}.json')
        frame_path = _os.path.join(diag_dir, f'vision-frame-{args.racer[:8]}.png')
        with open(diag_path, 'w') as f:
            _json.dump(diag, f, indent=2)
        cv2.imwrite(frame_path, frame)
        print(f'[Vision][Diag] Wrote diagnostics to {diag_path}', file=sys.stderr)
        print(f'[Vision][Diag] Wrote frame to {frame_path}', file=sys.stderr)

        # Write calibrated grid offset back to the crop profile in the DB
        if args.crop_profile_id and args.server:
            try:
                requests.put(
                    f'{args.server}/api/crop-profiles/{args.crop_profile_id}',
                    json={'grid_offset_dx': dx, 'grid_offset_dy': dy},
                    timeout=2,
                )
                print(f'[Vision][Diag] Updated crop profile {args.crop_profile_id[:8]} '
                      f'grid_offset dx={dx} dy={dy}', file=sys.stderr)
            except requests.RequestException as e:
                print(f'[Vision][Diag] Failed to update crop profile: {e}', file=sys.stderr)

    def process_frame(nes_canonical):
        """Process a single canonical frame and push state updates."""
        nonlocal frame_count
        state = detector.detect(nes_canonical)
        if state.screen_type in ('overworld', 'dungeon', 'cave'):
            run_diagnostics(nes_canonical)
        frame_count += 1

        # Apply game logic validation (carry-forward, streak, events)
        validated = validator.validate(state, frame_count)

        new_dict = validated.to_dict()
        if validated.screen_type != 'subscreen':
            for key in SUBSCREEN_ONLY_FIELDS:
                new_dict.pop(key, None)

        # Z1R: substitute accumulated inventory when subscreen reader returns {}
        items_in_state = merged_state.get('items', {})
        if not items_in_state:
            accumulated = validator.get_accumulated_inventory()
            if any(accumulated.values()):
                merged_state['items'] = accumulated

        merged_state.update(new_dict)
        delta = {k: v for k, v in merged_state.items() if prev_sent.get(k) != v}

        # Collect per-frame events (dynamically attached by validator)
        frame_events = getattr(validated, 'events', [])
        if frame_events:
            delta['game_events'] = frame_events

        if delta:
            try:
                requests.post(api_url, json=delta, timeout=1)
            except requests.RequestException as e:
                print(f'[Vision] Push failed: {e}', file=sys.stderr)
            # Don't persist game_events in prev_sent (one-shot, not delta-deduped)
            prev_sent.update({k: v for k, v in delta.items() if k != 'game_events'})

        if frame_count % 20 == 0:
            elapsed = time.time() - start_time
            fps = frame_count / elapsed if elapsed > 0 else 0
            cal_status = 'calibrated' if calibrated else 'uncalibrated'
            print(f'[Vision] {frame_count} frames, {fps:.1f} fps, '
                  f'state: {validated.screen_type} ({cal_status})', file=sys.stderr)

    first_frame_saved = False
    life_text_attempts = 0  # rate-limit calibrate_from_life_text (expensive)

    # ── Main loop ──
    while True:
        raw = sys.stdin.buffer.read(frame_size)
        if len(raw) < frame_size:
            print('[Vision] End of input stream', file=sys.stderr)
            break

        frame = np.frombuffer(raw, dtype=np.uint8).reshape(
            (args.height, args.width, 3)
        )

        # Crop to NES game area (initial crop from profile)
        # Handle negative crop_y/crop_x: when the full-frame crop extends
        # above/left of the stream frame (common when gameplayToFullCrop infers
        # the HUD area above a gameplay-only crop), pad with black pixels.
        fh, fw = frame.shape[:2]
        y1, y2 = crop_y, crop_y + crop_h
        x1, x2 = crop_x, crop_x + crop_w
        # Clamp source coordinates to frame boundaries
        sy1, sy2 = max(0, y1), min(fh, y2)
        sx1, sx2 = max(0, x1), min(fw, x2)
        # Offsets into the output region where the valid pixels go
        dy_off = sy1 - y1  # how many rows of padding at top
        dx_off = sx1 - x1  # how many cols of padding at left
        nes_region = np.zeros((crop_h, crop_w, 3), dtype=np.uint8)
        if sy2 > sy1 and sx2 > sx1:
            nes_region[dy_off:dy_off + (sy2 - sy1),
                       dx_off:dx_off + (sx2 - sx1)] = frame[sy1:sy2, sx1:sx2]

        # Apply sub-crop if detected (tighter NES game boundaries)
        if sub_crop is not None:
            sx, sy, sw, sh = sub_crop
            nes_region = nes_region[sy:sy + sh, sx:sx + sw]

        # Resize to canonical 256x240 using nearest-neighbor
        nes_canonical = cv2.resize(nes_region, (256, 240),
                                    interpolation=cv2.INTER_NEAREST)

        # Save first frame for debugging
        if not first_frame_saved:
            first_frame_saved = True
            import os as _os
            dbg_dir = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '..', 'data')
            _os.makedirs(dbg_dir, exist_ok=True)
            dbg_path = _os.path.join(dbg_dir, f'vision-firstframe-{args.racer[:8]}.png')
            cv2.imwrite(dbg_path, nes_canonical)
            print(f'[Vision] Saved first canonical frame to {dbg_path}', file=sys.stderr)

        # Try calibration on every frame until it succeeds
        if not calibrated:
            # Method 1: Direct grid alignment on canonical frame (works when crop is tight)
            detected = find_grid_alignment(nes_canonical)
            if detected is not None:
                grid_dx, grid_dy, life_row = detected
                calibrated = True
                diag_done = False
                first_frame_saved = False  # save new first frame with corrected crop
                detector = NesStateDetector(args.templates,
                                            grid_offset=(grid_dx, grid_dy),
                                            life_row=life_row)
                print(f'[Vision] Auto-calibrated (grid): dx={grid_dx} dy={grid_dy} '
                      f'life_row={life_row} (frame {frame_count + 1})',
                      file=sys.stderr)
            else:
                # Method 2: LIFE-text calibration on the cropped region (works when
                # crop is loose — finds NES game boundaries within the crop)
                # Only try every 5th frame to limit CPU cost
                life_text_attempts += 1
                if life_text_attempts % 5 == 1:
                    # Use the original nes_region (before sub-crop), full resolution
                    region_for_cal = frame[crop_y:crop_y + crop_h, crop_x:crop_x + crop_w]
                    cal = calibrate_from_life_text(region_for_cal)
                    if cal is not None:
                        sc_x, sc_y, sc_w, sc_h = cal['crop']
                        sub_crop = (sc_x, sc_y, sc_w, sc_h)
                        grid_dx, grid_dy = cal['grid_offset']
                        # Re-extract canonical with sub-crop applied
                        tight_region = region_for_cal[sc_y:sc_y + sc_h, sc_x:sc_x + sc_w]
                        nes_canonical = cv2.resize(tight_region, (256, 240),
                                                    interpolation=cv2.INTER_NEAREST)
                        # Now try grid alignment on the tight canonical
                        detected2 = find_grid_alignment(nes_canonical)
                        if detected2 is not None:
                            grid_dx, grid_dy, life_row = detected2
                        calibrated = True
                        diag_done = False
                        first_frame_saved = False
                        detector = NesStateDetector(args.templates,
                                                    grid_offset=(grid_dx, grid_dy),
                                                    life_row=life_row)
                        print(f'[Vision] Auto-calibrated (LIFE-text sub-crop): '
                              f'sub_crop=({sc_x},{sc_y},{sc_w},{sc_h}) '
                              f'dx={grid_dx} dy={grid_dy} life_row={life_row} '
                              f'(frame {frame_count + 1})', file=sys.stderr)

        # Always use native resolution for all detectors.
        # Compute effective crop: if sub_crop was applied, the actual NES region
        # in stream space is offset by (sx, sy) within the original crop.
        if sub_crop is not None:
            sx, sy, sw, sh = sub_crop
            eff_crop_x = crop_x + sx
            eff_crop_y = crop_y + sy
            eff_crop_w = sw
            eff_crop_h = sh
        else:
            eff_crop_x, eff_crop_y = crop_x, crop_y
            eff_crop_w, eff_crop_h = crop_w, crop_h

        detector.set_native_frame(frame, eff_crop_x, eff_crop_y, eff_crop_w, eff_crop_h)
        process_frame(nes_canonical)
        detector.clear_native_frame()

        # Overwrite live preview frame for VisionLab
        cv2.imwrite(frame_out_path, nes_canonical, [cv2.IMWRITE_JPEG_QUALITY, 75])


if __name__ == '__main__':
    main()
