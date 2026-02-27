"""Automated room matching for minimap calibration.

Compares gameplay screenshots against overworld room reference tiles
to detect and correct systematic minimap position offsets. The overworld
uses a 16x8 grid (4px per room in the 64px minimap). Dungeons share the
same physical pixel region but map to 8x8 (8px per room), so an overworld
calibration offset translates proportionally to dungeons.

The refinement pipeline is minimap-first: for each snapshot, re-read
Link's dot position from the minimap, then use that estimate as the
center for neighborhood image matching. This avoids false matches when
the stored position (from live frame processing) is wrong.
"""

import os
import sys
from collections import Counter

import cv2
import numpy as np

from .zelda_map import is_adjacent

# Comparison dimensions — small enough to smooth out Link/enemies,
# large enough to preserve terrain structure. Aspect ratio ≈ 1.45:1
# matches both NES gameplay area (256x176) and room tiles (226x155).
COMPARE_W = 64
COMPARE_H = 44

# NES frame layout
HUD_BOTTOM = 64     # HUD occupies rows 0-63
FRAME_H = 240
FRAME_W = 256

# Grid dimensions
OW_COLS = 16
OW_ROWS = 8
DG_COLS = 8
DG_ROWS = 8

# Pixels per room in the minimap (64px wide region)
OW_PX_PER_COL = 4   # 64 / 16
DG_PX_PER_COL = 8   # 64 / 8
PX_PER_ROW = 5      # 40 / 8 (shared)

# Minimap region in the 256x240 NES frame.
# Y1=12 (not 16) — empirically verified: with grid offset dy=2, effective
# y=[14,54] gives 79% correct room alignment vs map tiles. The original
# y=[18,58] caused a systematic +1 row error in ~71% of readings.
MINIMAP_Y1 = 12
MINIMAP_Y2 = 52
MINIMAP_X1 = 16
MINIMAP_X2 = 80
MINIMAP_ROWS = 8


def read_minimap_from_frame(nes_frame: np.ndarray, is_dungeon: bool = False,
                            grid_offset: tuple[int, int] = (1, 2)) -> int:
    """Re-read Link's dot position from the minimap in a NES frame.

    This replicates the HudReader.read_minimap_position logic so we can
    get a fresh position estimate from snapshot images without needing
    the full HudReader pipeline.

    Args:
        nes_frame: 256x240 BGR NES frame.
        is_dungeon: If True, map to 8-column dungeon grid.
        grid_offset: NES pixel grid offset (dx, dy). Default (1, 2).

    Returns:
        Room position (0-based), or 0 if position cannot be determined.
    """
    dx, dy = grid_offset
    grid_cols = DG_COLS if is_dungeon else OW_COLS

    x1 = MINIMAP_X1 + dx
    x2 = MINIMAP_X2 + dx
    y1 = MINIMAP_Y1 + dy
    y2 = MINIMAP_Y2 + dy

    # Bounds check
    if (y1 < 0 or y2 > nes_frame.shape[0]
            or x1 < 0 or x2 > nes_frame.shape[1]):
        return 0

    minimap = nes_frame[y1:y2, x1:x2]
    if minimap.size == 0:
        return 0

    gray = np.mean(minimap, axis=2)
    threshold = float(np.max(gray)) * 0.8
    if threshold < 80:
        return 0

    bright_mask = (gray > threshold).astype(np.uint8)
    bright_coords = np.argwhere(bright_mask)
    if len(bright_coords) == 0:
        return 0

    # Use largest connected component to filter scattered noise pixels.
    # The player dot is a tight cluster; noise pixels are isolated.
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(bright_mask)
    if num_labels <= 1:
        return 0
    # Label 0 is background; find largest foreground component
    best_label = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    cluster = np.argwhere(labels == best_label)

    center_y = float(np.mean(cluster[:, 0]))
    center_x = float(np.mean(cluster[:, 1]))

    map_h = y2 - y1
    map_w = x2 - x1
    col = int(center_x / map_w * grid_cols)
    row = int(center_y / map_h * MINIMAP_ROWS)
    col = max(0, min(col, grid_cols - 1))
    row = max(0, min(row, MINIMAP_ROWS - 1))

    return row * grid_cols + col


class RoomMatcher:
    """Matches gameplay frames against overworld room reference tiles."""

    def __init__(self, room_tiles_dir: str):
        self.tiles_dir = room_tiles_dir
        self._cache: dict[int, np.ndarray] = {}

    def _load_tile(self, position: int, cols: int = OW_COLS) -> np.ndarray | None:
        """Load and preprocess a room tile. Returns COMPARE_W x COMPARE_H grayscale."""
        if position in self._cache:
            return self._cache[position]

        row = position // cols
        col = position % cols
        path = os.path.join(self.tiles_dir, f'C{col + 1}_R{row + 1}.jpg')
        img = cv2.imread(path)
        if img is None:
            return None

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        resized = cv2.resize(gray, (COMPARE_W, COMPARE_H), interpolation=cv2.INTER_AREA)
        self._cache[position] = resized
        return resized

    def _crop_gameplay(self, nes_frame: np.ndarray) -> np.ndarray:
        """Crop HUD from NES frame, return COMPARE_W x COMPARE_H grayscale."""
        gameplay = nes_frame[HUD_BOTTOM:FRAME_H, :FRAME_W]
        gray = cv2.cvtColor(gameplay, cv2.COLOR_BGR2GRAY)
        resized = cv2.resize(gray, (COMPARE_W, COMPARE_H), interpolation=cv2.INTER_AREA)
        return resized

    def match(self, nes_frame: np.ndarray, detected_pos: int,
              cols: int = OW_COLS, rows: int = OW_ROWS,
              radius: int = 1) -> tuple[int, float]:
        """Compare gameplay frame against a neighborhood of room tiles.

        Args:
            nes_frame: 256x240 BGR NES frame.
            detected_pos: Detected room position (0-based).
            cols: Grid columns (16 for overworld).
            rows: Grid rows (8).
            radius: Neighborhood radius (1 = 3x3, 2 = 5x5).

        Returns:
            (best_position, best_score) where score is Pearson correlation [-1, 1].
        """
        gameplay = self._crop_gameplay(nes_frame)
        gameplay_flat = gameplay.astype(np.float64).flatten()

        # Precompute gameplay stats for Pearson correlation
        gp_mean = np.mean(gameplay_flat)
        gp_std = np.std(gameplay_flat)
        if gp_std < 1e-6:
            # Nearly uniform frame (blank/transition) — can't match
            return detected_pos, 0.0

        gp_norm = gameplay_flat - gp_mean

        best_pos = detected_pos
        best_score = -1.0
        det_row = detected_pos // cols
        det_col = detected_pos % cols

        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                r = det_row + dr
                c = det_col + dc
                if r < 0 or r >= rows or c < 0 or c >= cols:
                    continue

                pos = r * cols + c
                tile = self._load_tile(pos, cols)
                if tile is None:
                    continue

                tile_flat = tile.astype(np.float64).flatten()
                tile_std = np.std(tile_flat)
                if tile_std < 1e-6:
                    continue

                tile_norm = tile_flat - np.mean(tile_flat)
                score = float(np.dot(gp_norm, tile_norm) / (gp_std * tile_std * len(gp_norm)))

                if score > best_score:
                    best_score = score
                    best_pos = pos

        return best_pos, round(best_score, 4)


def calibrate_positions(snapshots: list[dict], snapshots_dir: str,
                        room_tiles_dir: str) -> dict | None:
    """Auto-calibrate overworld positions using room tile matching.

    Compares gameplay screenshots against reference tiles to find a
    systematic minimap offset. If 3+ snapshots agree on the same offset,
    applies the correction to all overworld (and proportionally to dungeon)
    snapshot positions in-place.

    Args:
        snapshots: List of snapshot metadata dicts (modified in-place).
        snapshots_dir: Directory containing snapshot JPEG files.
        room_tiles_dir: Directory containing room reference tiles (C{col}_R{row}.jpg).

    Returns:
        Calibration result dict, or None if calibration could not be determined.
    """
    if not os.path.isdir(room_tiles_dir):
        return None

    matcher = RoomMatcher(room_tiles_dir)

    # Only process overworld snapshots with a detected position
    ow_snaps = [s for s in snapshots
                if s.get('screenType') == 'overworld' and s.get('mapPosition', 0) > 0]

    if len(ow_snaps) < 3:
        return None

    offsets: list[tuple[int, int]] = []
    match_log: list[dict] = []

    for snap in ow_snaps[:20]:
        img_path = os.path.join(snapshots_dir, snap['filename'])
        img = cv2.imread(img_path)
        if img is None:
            continue

        # Downscale 512x480 JPEG back to 256x240 NES resolution
        nes_frame = cv2.resize(img, (FRAME_W, FRAME_H), interpolation=cv2.INTER_AREA)
        detected = snap['mapPosition']

        # Minimap-first: re-read the minimap dot to get a fresh estimate
        minimap_pos = read_minimap_from_frame(nes_frame, is_dungeon=False)
        search_center = minimap_pos if minimap_pos > 0 else detected

        # Try 3x3 neighborhood centered on minimap estimate
        matched, score = matcher.match(nes_frame, search_center, radius=1)
        if score < 0.3:
            # Poor match in 3x3, expand to 5x5
            matched, score = matcher.match(nes_frame, search_center, radius=2)
        if score < 0.2:
            # Still poor — skip this snapshot (transition frame, blank screen, etc.)
            continue

        det_r, det_c = detected // OW_COLS, detected % OW_COLS
        mat_r, mat_c = matched // OW_COLS, matched % OW_COLS
        offset = (mat_c - det_c, mat_r - det_r)
        offsets.append(offset)

        match_log.append({
            'filename': snap['filename'],
            'detected': detected,
            'matched': matched,
            'score': score,
            'offset': list(offset),
        })

        # Early exit once calibration is stable (3+ agreeing out of 4+)
        if len(offsets) >= 4:
            most_common_offset, most_common_count = Counter(offsets).most_common(1)[0]
            if most_common_count >= 3:
                break

    if not offsets:
        return None

    offset_counts = Counter(offsets)
    (dcol, drow), count = offset_counts.most_common(1)[0]

    if count < 3:
        # No consensus — can't reliably calibrate
        return None

    applied = dcol != 0 or drow != 0

    # Derive dungeon column offset from pixel-level correction
    pixel_dx = dcol * OW_PX_PER_COL
    pixel_dy = drow * PX_PER_ROW
    dcol_dg = round(pixel_dx / DG_PX_PER_COL)

    if applied:
        for snap in snapshots:
            pos = snap.get('mapPosition', 0)
            if pos <= 0:
                continue

            screen = snap.get('screenType', '')
            if screen == 'overworld':
                old_r, old_c = pos // OW_COLS, pos % OW_COLS
                new_c = max(0, min(OW_COLS - 1, old_c + dcol))
                new_r = max(0, min(OW_ROWS - 1, old_r + drow))
                snap['mapPosition'] = new_r * OW_COLS + new_c
            elif screen == 'dungeon' and (dcol_dg != 0 or drow != 0):
                old_r, old_c = pos // DG_COLS, pos % DG_COLS
                new_c = max(0, min(DG_COLS - 1, old_c + dcol_dg))
                new_r = max(0, min(DG_ROWS - 1, old_r + drow))
                snap['mapPosition'] = new_r * DG_COLS + new_c

    # ─── Per-snapshot refinement (minimap-first) ───
    # The minimap dot is the primary authority for position. For each snapshot:
    #   1. Re-read the minimap dot position — this is the best estimate.
    #   2. For overworld: optionally confirm with a room-tile image match
    #      in the 3×3 neighborhood around the minimap reading.
    #   3. For dungeon: no reference tiles, so minimap is the sole authority.
    #   4. During screen transitions: the minimap dot is still readable
    #      (HUD is static), so trust it even when gameplay area is mid-wipe.
    #
    # IMPORTANT: The minimap re-read returns RAW pixel positions (uncalibrated).
    # The stored mapPosition has already been shifted by the global calibration
    # offset (dcol, drow). We must apply the same offset to the minimap reading
    # before comparing, otherwise we'd undo the calibration.
    refined = 0
    minimap_corrections = 0
    image_corrections = 0
    total_checked = 0

    # Build list of gameplay snapshot indices with valid positions
    # (both overworld AND dungeon — dungeons need minimap refinement too)
    gp_indices = [i for i, s in enumerate(snapshots)
                  if s.get('screenType') in ('overworld', 'dungeon')
                  and s.get('mapPosition', 0) > 0]

    if not gp_indices:
        return {
            'offset_col': dcol, 'offset_row': drow,
            'offset_col_dungeon': dcol_dg,
            'pixel_dx': pixel_dx, 'pixel_dy': pixel_dy,
            'confidence': round(count / len(offsets), 2),
            'samples': len(offsets), 'applied': applied,
            'matches': match_log, 'refined': 0, 'refined_checked': 0,
        }

    # Group into runs of consecutive same-position, same-screenType snapshots
    runs: list[list[int]] = []  # each run is a list of indices into snapshots[]
    current_run: list[int] = [gp_indices[0]]
    for k in range(1, len(gp_indices)):
        prev_s = snapshots[gp_indices[k - 1]]
        curr_s = snapshots[gp_indices[k]]
        if (curr_s['mapPosition'] == prev_s['mapPosition']
                and curr_s['screenType'] == prev_s['screenType']):
            current_run.append(gp_indices[k])
        else:
            runs.append(current_run)
            current_run = [gp_indices[k]]
    runs.append(current_run)

    def _apply_calibration(raw_pos: int, is_dungeon: bool) -> int:
        """Apply global calibration offset to a raw minimap reading."""
        if raw_pos <= 0:
            return raw_pos
        if is_dungeon:
            cols, rows = DG_COLS, DG_ROWS
            d_col, d_row = dcol_dg, drow
        else:
            cols, rows = OW_COLS, OW_ROWS
            d_col, d_row = dcol, drow
        r = raw_pos // cols
        c = raw_pos % cols
        new_c = max(0, min(cols - 1, c + d_col))
        new_r = max(0, min(rows - 1, r + d_row))
        return new_r * cols + new_c

    def _check_and_correct(snap_idx: int) -> int | None:
        """Minimap-first refinement for a single snapshot.

        The minimap dot is authoritative. Image matching is only used
        as a secondary confirmation for overworld (where we have tiles).

        Also tags the snapshot with positionConfidence:
          'high'   — minimap + image match agree, or minimap confirmed by neighbor
          'low'    — transition frame or conflicting signals; needs human review
          'medium' — minimap only (dungeon) or minor correction

        Returns corrected position, or None if no correction needed.
        """
        nonlocal total_checked, minimap_corrections, image_corrections
        snap = snapshots[snap_idx]
        stored_pos = snap['mapPosition']
        is_dungeon = snap.get('screenType') == 'dungeon'
        img_path = os.path.join(snapshots_dir, snap['filename'])
        img = cv2.imread(img_path)
        if img is None:
            return None

        nes_frame = cv2.resize(img, (FRAME_W, FRAME_H), interpolation=cv2.INTER_AREA)
        total_checked += 1

        # Step 1: Re-read minimap dot — primary authority
        # Apply global calibration offset so it's comparable to stored_pos
        raw_minimap = read_minimap_from_frame(nes_frame, is_dungeon=is_dungeon)
        minimap_pos = _apply_calibration(raw_minimap, is_dungeon)

        if minimap_pos > 0 and minimap_pos != stored_pos:
            # Calibrated minimap disagrees with stored position —
            # likely a per-snapshot correction (minimap lag, etc.)
            if is_dungeon:
                # Dungeon: no reference tiles — minimap is the sole authority
                minimap_corrections += 1
                snap['positionConfidence'] = 'medium'
                return minimap_pos

            # Overworld: confirm with image match centered on minimap reading
            matched, score = matcher.match(nes_frame, minimap_pos, radius=1)
            if score >= 0.35 and matched != stored_pos:
                # Image match confirms a correction — high confidence
                image_corrections += 1
                snap['positionConfidence'] = 'high'
                return matched
            else:
                # Image match is weak (likely screen transition) but minimap
                # clearly shows a different position. Trust minimap, but flag
                # as low confidence — the gameplay area may be mid-transition.
                minimap_corrections += 1
                snap['positionConfidence'] = 'low'
                return minimap_pos

        elif minimap_pos > 0 and minimap_pos == stored_pos:
            # Minimap agrees with stored — position is confirmed
            if not is_dungeon:
                matched, score = matcher.match(nes_frame, stored_pos, radius=1)
                if score >= 0.35:
                    snap['positionConfidence'] = 'high'
                else:
                    # Minimap matches but image doesn't — transition frame
                    snap['positionConfidence'] = 'low'
            else:
                snap['positionConfidence'] = 'medium'

        elif minimap_pos == 0 and not is_dungeon:
            # Minimap unreadable — try image match as fallback (overworld only)
            matched, score = matcher.match(nes_frame, stored_pos, radius=1)
            if score >= 0.40 and matched != stored_pos:
                image_corrections += 1
                snap['positionConfidence'] = 'low'
                return matched
            elif score >= 0.35:
                snap['positionConfidence'] = 'medium'
            else:
                snap['positionConfidence'] = 'low'

        elif minimap_pos == 0:
            snap['positionConfidence'] = 'low'

        return None

    for run in runs:
        # Check first snapshot in run
        first_correction = _check_and_correct(run[0])
        if first_correction is not None:
            snapshots[run[0]]['mapPosition'] = first_correction
            refined += 1

        # Check last snapshot if run has more than 1 element
        if len(run) > 1:
            last_correction = _check_and_correct(run[-1])
            if last_correction is not None:
                snapshots[run[-1]]['mapPosition'] = last_correction
                refined += 1
                # If last differs from first, update trailing snapshots
                # backwards from the end until we hit a different match
                for k in range(len(run) - 2, 0, -1):
                    mid_correction = _check_and_correct(run[k])
                    if mid_correction == last_correction:
                        snapshots[run[k]]['mapPosition'] = last_correction
                        refined += 1
                    else:
                        break  # Transition point found

    # ─── Second pass: resolve low-confidence snapshots from neighbors ───
    # If a snapshot has low confidence (transition frame, unreadable minimap),
    # but the previous and next gameplay snapshots both have confident
    # positions that are adjacent or the same, we can assign the position
    # from context and throw out the ambiguity.
    resolved = 0
    for k in range(len(gp_indices)):
        idx = gp_indices[k]
        snap = snapshots[idx]
        if snap.get('positionConfidence') != 'low':
            continue

        # Find previous confident gameplay snapshot
        prev_snap = None
        for j in range(k - 1, -1, -1):
            candidate = snapshots[gp_indices[j]]
            if candidate.get('positionConfidence', 'medium') in ('high', 'medium'):
                prev_snap = candidate
                break

        # Find next confident gameplay snapshot
        next_snap = None
        for j in range(k + 1, len(gp_indices)):
            candidate = snapshots[gp_indices[j]]
            if candidate.get('positionConfidence', 'medium') in ('high', 'medium'):
                next_snap = candidate
                break

        if not prev_snap or not next_snap:
            continue

        prev_pos = prev_snap['mapPosition']
        next_pos = next_snap['mapPosition']
        prev_st = prev_snap.get('screenType', '')
        next_st = next_snap.get('screenType', '')
        snap_st = snap.get('screenType', '')

        # Only resolve within the same screen type (overworld or dungeon)
        if prev_st != next_st or prev_st != snap_st:
            continue

        cols = DG_COLS if snap_st == 'dungeon' else OW_COLS

        if prev_pos == next_pos:
            # Same room — the transition frame is just noise
            if snap['mapPosition'] != prev_pos:
                snap['mapPosition'] = prev_pos
                refined += 1
            snap['positionConfidence'] = 'high'
            resolved += 1
        elif is_adjacent(prev_pos, next_pos, cols):
            # Adjacent rooms — player moved between them. Assign destination.
            if snap['mapPosition'] != next_pos:
                snap['mapPosition'] = next_pos
                refined += 1
            snap['positionConfidence'] = 'medium'
            resolved += 1

    if refined > 0:
        print(f'[Learn] Per-snapshot refinement: corrected {refined}/{total_checked} positions'
              f' ({minimap_corrections} minimap, {image_corrections} image match,'
              f' {resolved} resolved from neighbors)',
              file=sys.stderr)

    return {
        'offset_col': dcol,
        'offset_row': drow,
        'offset_col_dungeon': dcol_dg,
        'pixel_dx': pixel_dx,
        'pixel_dy': pixel_dy,
        'confidence': round(count / len(offsets), 2),
        'samples': len(offsets),
        'applied': applied or refined > 0,
        'matches': match_log,
        'refined': refined,
        'refined_checked': total_checked,
        'minimap_corrections': minimap_corrections,
        'image_corrections': image_corrections,
    }
