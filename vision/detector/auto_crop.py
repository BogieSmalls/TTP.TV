"""Auto-detect the NES Zelda 1 game region within a stream frame.

Given a full stream frame (e.g. 1920x1080), finds the rectangular area
containing the NES game output by:
1. Edge detection + contour finding for candidate rectangles
2. Aspect ratio filtering (NES outputs at ~256:240 = 1.067)
3. HUD verification (checking for Zelda-specific visual features)

Usage:
    python -m detector.auto_crop --input frame.png
    python -m detector.auto_crop --source "https://twitch.tv/videos/..." --sample-count 5
"""

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, asdict

import cv2
import numpy as np


@dataclass
class CropResult:
    """Detected NES game region within a stream frame."""
    x: int
    y: int
    w: int
    h: int
    confidence: float           # 0.0–1.0
    aspect_ratio: float         # detected width/height ratio
    source_width: int
    source_height: int
    hud_verified: bool

    def to_dict(self) -> dict:
        return asdict(self)


# NES aspect ratio: 256/240 = 1.0667
# With pixel aspect ratio correction (8:7), it becomes ~1.217
# Accept a range to handle both cases plus slight capture distortion
MIN_ASPECT = 0.95
MAX_ASPECT = 1.35

# Minimum game region size as fraction of frame area
MIN_AREA_FRACTION = 0.03   # at least 3% of frame
MAX_AREA_FRACTION = 0.95   # not the entire frame


class AutoCropDetector:
    """Detect the NES game region in a stream frame."""

    def detect_crop(self, frame: np.ndarray) -> CropResult | None:
        """Find the NES Zelda 1 game region in a single frame.

        Args:
            frame: BGR image (e.g. 1920x1080x3).

        Returns:
            CropResult or None if no valid region found.
        """
        h, w = frame.shape[:2]
        frame_area = h * w
        min_area = frame_area * MIN_AREA_FRACTION
        max_area = frame_area * MAX_AREA_FRACTION

        candidates = self._find_rectangle_candidates(frame, min_area, max_area)

        if not candidates:
            return None

        # Score and verify each candidate
        best: CropResult | None = None
        best_score = -1.0

        for (cx, cy, cw, ch) in candidates:
            aspect = cw / ch
            if aspect < MIN_ASPECT or aspect > MAX_ASPECT:
                continue

            # Score: prefer larger regions with better aspect ratio match
            area_score = (cw * ch) / frame_area  # 0-1, bigger = better
            aspect_score = 1.0 - min(abs(aspect - 1.067) / 0.3, 1.0)  # closeness to NES ratio
            size_penalty = 1.0 if area_score < 0.8 else max(0.0, 1.0 - (area_score - 0.8) * 5)

            score = (area_score * 0.3 + aspect_score * 0.4 + size_penalty * 0.3)

            # HUD verification — does this region look like a Zelda 1 game?
            hud_ok = self._verify_hud(frame, cx, cy, cw, ch)
            if hud_ok:
                score += 0.5  # big bonus for HUD match

            if score > best_score:
                best_score = score
                best = CropResult(
                    x=cx, y=cy, w=cw, h=ch,
                    confidence=min(score, 1.0),
                    aspect_ratio=aspect,
                    source_width=w,
                    source_height=h,
                    hud_verified=hud_ok,
                )

        return best

    def detect_crop_multi(self, frames: list[np.ndarray]) -> CropResult | None:
        """Find crop region using multiple frames for stability.

        Runs detection on each frame and takes the median rectangle.

        Args:
            frames: List of BGR images.

        Returns:
            CropResult with median coordinates, or None.
        """
        results: list[CropResult] = []

        for frame in frames:
            r = self.detect_crop(frame)
            if r is not None:
                results.append(r)

        if not results:
            return None

        # Take median of all detected rectangles
        xs = sorted(r.x for r in results)
        ys = sorted(r.y for r in results)
        ws = sorted(r.w for r in results)
        hs = sorted(r.h for r in results)
        mid = len(results) // 2

        median_result = CropResult(
            x=xs[mid],
            y=ys[mid],
            w=ws[mid],
            h=hs[mid],
            confidence=sum(r.confidence for r in results) / len(results),
            aspect_ratio=ws[mid] / hs[mid],
            source_width=results[0].source_width,
            source_height=results[0].source_height,
            hud_verified=any(r.hud_verified for r in results),
        )

        return median_result

    def _find_rectangle_candidates(
        self, frame: np.ndarray, min_area: float, max_area: float,
    ) -> list[tuple[int, int, int, int]]:
        """Find rectangular contours in the frame.

        Returns list of (x, y, w, h) tuples.
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # Use multiple edge detection approaches for robustness
        candidates: list[tuple[int, int, int, int]] = []

        # Approach 1: Canny edge detection
        edges = cv2.Canny(gray, 30, 100)
        candidates.extend(self._contours_to_rects(edges, min_area, max_area))

        # Approach 2: Adaptive threshold (catches borders missed by Canny)
        thresh = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2,
        )
        candidates.extend(self._contours_to_rects(thresh, min_area, max_area))

        # Approach 3: Look for dark rectangular borders (common in NES captures)
        # Many streamers have the NES game surrounded by a solid border
        dark_mask = (gray < 30).astype(np.uint8) * 255
        # Dilate to connect nearby dark pixels into a border
        kernel = np.ones((5, 5), np.uint8)
        dark_dilated = cv2.dilate(dark_mask, kernel, iterations=2)
        # Find the inner area (invert and find contours)
        inner = cv2.bitwise_not(dark_dilated)
        candidates.extend(self._contours_to_rects(inner, min_area, max_area))

        # Deduplicate: merge candidates that are very close to each other
        return self._deduplicate_rects(candidates)

    def _contours_to_rects(
        self, binary: np.ndarray, min_area: float, max_area: float,
    ) -> list[tuple[int, int, int, int]]:
        """Extract rectangles from a binary/edge image."""
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        rects: list[tuple[int, int, int, int]] = []

        for contour in contours:
            area = cv2.contourArea(contour)
            if area < min_area or area > max_area:
                continue

            # Approximate to polygon
            peri = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * peri, True)

            # Accept 4-point polygons (rectangles)
            if len(approx) == 4:
                x, y, w, h = cv2.boundingRect(approx)
                if w > 0 and h > 0:
                    rects.append((x, y, w, h))
            else:
                # Also try bounding rectangle for irregular contours
                x, y, w, h = cv2.boundingRect(contour)
                # Check if bounding rect area is close to contour area (rectangle-like)
                rect_area = w * h
                if rect_area > 0 and area / rect_area > 0.85:
                    rects.append((x, y, w, h))

        return rects

    def _deduplicate_rects(
        self, rects: list[tuple[int, int, int, int]], threshold: int = 20,
    ) -> list[tuple[int, int, int, int]]:
        """Merge rectangles that are very close to each other."""
        if not rects:
            return []

        unique: list[tuple[int, int, int, int]] = []
        for r in rects:
            is_dup = False
            for u in unique:
                if (abs(r[0] - u[0]) < threshold and abs(r[1] - u[1]) < threshold
                        and abs(r[2] - u[2]) < threshold and abs(r[3] - u[3]) < threshold):
                    is_dup = True
                    break
            if not is_dup:
                unique.append(r)

        return unique

    def _verify_hud(self, frame: np.ndarray, x: int, y: int, w: int, h: int) -> bool:
        """Verify that a candidate region contains a Zelda 1 HUD.

        Extracts the region, resizes to 256x240, and checks for HUD features:
        - Dark HUD background in top ~27% of frame (64/240)
        - Heart-colored pixels at expected positions
        - Minimap dark region at top-left
        """
        # Extract and resize to canonical NES resolution
        region = frame[y:y + h, x:x + w]
        if region.size == 0:
            return False

        canonical = cv2.resize(region, (256, 240), interpolation=cv2.INTER_NEAREST)

        # Check 1: HUD background should be mostly dark (top 64 rows)
        hud_area = canonical[0:64, :, :]
        hud_brightness = float(np.mean(hud_area))
        if hud_brightness > 80:
            return False  # HUD area too bright — probably not the game

        # Check 2: Game area below HUD should be brighter than HUD
        game_area = canonical[64:240, :, :]
        game_brightness = float(np.mean(game_area))
        if game_brightness < hud_brightness:
            return False  # Game area darker than HUD — unlikely

        # Check 3: Look for red-ish pixels in the hearts region (row ~32, x 176-240)
        heart_region = canonical[28:44, 170:248, :]
        r_channel = heart_region[:, :, 2].astype(float)
        g_channel = heart_region[:, :, 1].astype(float)
        # Check for any red-dominant pixels (hearts)
        red_mask = (r_channel > 80) & (r_channel > g_channel * 1.3)
        red_ratio = float(np.sum(red_mask)) / float(max(red_mask.size, 1))
        # Hearts may not always be visible (title screen, death), so this is a soft check
        has_hearts = red_ratio > 0.05

        # Check 4: Minimap region should be distinct (top-left, rows 16-60, cols 16-64)
        minimap = canonical[16:60, 16:64, :]
        minimap_brightness = float(np.mean(minimap))
        # Minimap is typically dark with some colored dots
        minimap_ok = minimap_brightness < 60

        # Need at least 2 of the soft checks to pass
        soft_checks = sum([has_hearts, minimap_ok, game_brightness > 20])
        return soft_checks >= 2


# ─── LIFE-text auto-calibration ───
#
# The NES Zelda 1 HUD always shows "-LIFE-" (or "-ROAR-") in bright red text
# at fixed tile positions: row 5, cols 21-26 → NES pixels (168,40) to (216,48).
# Hearts appear at rows 3-5, cols 22-31. By finding these red pixel clusters
# in the raw stream frame, we can derive the crop region and grid offset
# without relying on contour detection.


def find_grid_offset(canonical_frame: np.ndarray) -> tuple[int, int] | None:
    """Find optimal (dx, dy) grid offset for a 256x240 canonical NES frame.

    Tests all 64 possible offsets (0-7 for each axis) across multiple candidate
    tile rows and returns the one where the LIFE text tiles are most clearly
    red, with verification that the tile beyond the LIFE text is NOT red
    (to distinguish from hearts which also appear red at nearby positions).

    The returned (dx, dy) is the pixel-level grid alignment offset.
    Use find_grid_alignment() to also get the actual LIFE text row.

    Args:
        canonical_frame: 256x240 BGR frame (already cropped and resized).

    Returns:
        (dx, dy) tuple, or None if no offset produces red LIFE text.
    """
    result = find_grid_alignment(canonical_frame)
    if result is None:
        return None
    return (result[0], result[1])


def find_grid_alignment(canonical_frame: np.ndarray) -> tuple[int, int, int] | None:
    """Find grid offset AND the actual LIFE text row in the canonical frame.

    Different stream captures may position the NES HUD at different vertical
    offsets due to overscan, crop alignment, etc. This function searches
    multiple candidate tile rows and returns which row the LIFE text is at.

    Args:
        canonical_frame: 256x240 BGR frame (already cropped and resized).

    Returns:
        (dx, dy, life_row) tuple where life_row is the tile row (3-6) where
        LIFE text was found, or None if no offset produces red LIFE text.
    """
    best_result = None
    best_score = -1.0

    # LIFE text can appear at different tile rows depending on crop alignment.
    # Standard position is row 5, but crop/overscan shifts can put it at row 3-6.
    LIFE_COL = 22   # "L" column
    CANDIDATE_ROWS = [3, 4, 5, 6]

    for life_row in CANDIDATE_ROWS:
        for dy in range(8):
            for dx in range(8):
                y = life_row * 8 + dy
                x = LIFE_COL * 8 + dx
                if x + 8 > 256 or y + 8 > 240:
                    continue

                tile = canonical_frame[y:y + 8, x:x + 8]
                avg = np.mean(tile, axis=(0, 1))
                r, g, b = float(avg[2]), float(avg[1]), float(avg[0])

                if r > 50 and r > g * 2 and r > b * 2:
                    score = r - (g + b) / 2

                    # Bonus: check "I" at col 23
                    x2 = 23 * 8 + dx
                    if x2 + 8 <= 256:
                        tile2 = canonical_frame[y:y + 8, x2:x2 + 8]
                        avg2 = np.mean(tile2, axis=(0, 1))
                        r2 = float(avg2[2])
                        if r2 > 50 and r2 > float(avg2[1]) * 2:
                            score += r2 / 2

                    # Bonus: check "F" at col 24
                    x3 = 24 * 8 + dx
                    if x3 + 8 <= 256:
                        tile3 = canonical_frame[y:y + 8, x3:x3 + 8]
                        avg3 = np.mean(tile3, axis=(0, 1))
                        r3 = float(avg3[2])
                        if r3 > 50 and r3 > float(avg3[1]) * 2:
                            score += r3 / 3

                    # CRITICAL: Verify this is LIFE text, not hearts.
                    # LIFE text "-LIFE-" spans cols 21-26. Col 27+ should be
                    # dark (empty). Hearts span cols 22-29+, so col 27 would
                    # still be red for hearts. Reject if col 27 is red.
                    x_beyond = 27 * 8 + dx
                    if x_beyond + 8 <= 256:
                        tile_beyond = canonical_frame[y:y + 8, x_beyond:x_beyond + 8]
                        avg_beyond = np.mean(tile_beyond, axis=(0, 1))
                        r_beyond = float(avg_beyond[2])
                        if r_beyond > 50 and r_beyond > float(avg_beyond[1]) * 1.5:
                            # Col 27 is also red — likely hearts, not LIFE text
                            score *= 0.1  # heavily penalize

                    if score > best_score:
                        best_score = score
                        best_result = (dx, dy, life_row)

    return best_result


def _score_calibration(canonical: np.ndarray, dx: int, dy: int) -> float:
    """Score how well a canonical frame with given offset looks like Zelda 1."""
    score = 0.0

    # Check LIFE text at (col=22, row=5)
    y = 5 * 8 + dy
    x = 22 * 8 + dx
    if x + 8 <= 256 and y + 8 <= 240:
        tile = canonical[y:y + 8, x:x + 8]
        avg = np.mean(tile, axis=(0, 1))
        r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
        if r > 50 and r > g * 2 and r > b * 2:
            score += 0.5

        # Second character at (col=23, row=5)
        x2 = 23 * 8 + dx
        if x2 + 8 <= 256:
            tile2 = canonical[y:y + 8, x2:x2 + 8]
            avg2 = np.mean(tile2, axis=(0, 1))
            if float(avg2[2]) > 50 and float(avg2[2]) > float(avg2[1]) * 2:
                score += 0.3

    # HUD background should be dark (top 64 rows)
    hud_area = canonical[:64, :, :]
    hud_bright = float(np.mean(hud_area))
    if hud_bright < 80:
        score += 0.3

    # Game area should be brighter than HUD
    game_area = canonical[64:240, :, :]
    game_bright = float(np.mean(game_area))
    if game_bright > hud_bright and game_bright > 20:
        score += 0.3

    # Minimap area should be dark (top-left of HUD)
    my1, my2 = 16 + dy, min(52 + dy, 240)
    mx1, mx2 = 16 + dx, min(64 + dx, 256)
    if my2 > my1 and mx2 > mx1:
        minimap = canonical[my1:my2, mx1:mx2]
        if minimap.size > 0 and float(np.mean(minimap)) < 60:
            score += 0.2

    return score


def calibrate_from_life_text(frame: np.ndarray) -> dict | None:
    """Find NES game region and grid offset by locating -LIFE- HUD text.

    Scans the frame for red pixel clusters characteristic of the Zelda 1
    HUD, then tests candidate crop regions and grid offsets to find the
    best match.

    Args:
        frame: Full stream frame (BGR, any resolution).

    Returns:
        Dict with 'crop' (x,y,w,h), 'grid_offset' (dx,dy), 'scale', 'confidence'.
        Or None if LIFE text could not be located.
    """
    h, w = frame.shape[:2]

    # ─── Step 1: Find red pixel clusters ───
    r_ch = frame[:, :, 2].astype(np.int16)
    g_ch = frame[:, :, 1].astype(np.int16)
    b_ch = frame[:, :, 0].astype(np.int16)
    red_mask = ((r_ch > 80) & (r_ch > g_ch * 2) & (r_ch > b_ch * 2)).astype(np.uint8)

    # Only search top 60% of frame
    red_mask[int(h * 0.6):, :] = 0

    # Dilate to connect nearby red pixels into clusters
    kernel = np.ones((5, 5), np.uint8)
    red_dilated = cv2.dilate(red_mask, kernel, iterations=2)

    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(red_dilated)

    # ─── Step 2: For each red cluster, try to build a calibration ───
    best = None
    best_score = 0.0

    for label in range(1, num_labels):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < 50:
            continue

        bx = stats[label, cv2.CC_STAT_LEFT]
        by = stats[label, cv2.CC_STAT_TOP]
        bw = stats[label, cv2.CC_STAT_WIDTH]
        bh = stats[label, cv2.CC_STAT_HEIGHT]

        # The red HUD region (hearts + LIFE text) spans:
        #   NES rows 3-5 = 24 NES pixels tall, or just row 5 = 8 pixels, etc.
        # Try multiple hypotheses for what NES region this cluster maps to.
        for nes_h, nes_top in [(24, 24), (16, 32), (8, 40)]:
            scale = bh / nes_h
            if scale < 1.5 or scale > 5.0:
                continue

            # Try different x-origin hypotheses:
            # Col 21 (LIFE dash) = NES x 168, Col 22 (first heart/L) = NES x 176
            for nes_x_left in [168, 176, 160]:
                crop_x = round(bx - nes_x_left * scale)
                crop_y = round(by - nes_top * scale)
                crop_w = round(256 * scale)
                crop_h = round(240 * scale)

                # Clamp to frame
                crop_x = max(0, min(crop_x, w - crop_w))
                crop_y = max(0, min(crop_y, h - crop_h))

                if (crop_w < 100 or crop_h < 100
                        or crop_x + crop_w > w or crop_y + crop_h > h):
                    continue

                region = frame[crop_y:crop_y + crop_h, crop_x:crop_x + crop_w]
                if region.size == 0:
                    continue
                canonical = cv2.resize(region, (256, 240), interpolation=cv2.INTER_NEAREST)

                offset = find_grid_offset(canonical)
                if offset is None:
                    continue

                score = _score_calibration(canonical, *offset)
                if score > best_score:
                    best_score = score
                    best = {
                        'crop': (crop_x, crop_y, crop_w, crop_h),
                        'grid_offset': offset,
                        'scale': scale,
                        'confidence': min(score / 1.6, 1.0),
                    }

    return best


def _resolve_stream_url(source: str) -> str:
    """For Twitch VODs, resolve to a direct URL via streamlink. Otherwise return as-is."""
    if 'twitch.tv' not in source:
        return source
    try:
        print(f'[auto_crop] Resolving Twitch VOD URL via streamlink...', file=sys.stderr)
        sl = subprocess.run(
            ['streamlink', source, 'best', '--stream-url'],
            capture_output=True, text=True, timeout=30,
        )
        if sl.returncode == 0 and sl.stdout.strip():
            url = sl.stdout.strip()
            print(f'[auto_crop] Resolved to direct URL', file=sys.stderr)
            return url
    except Exception as e:
        print(f'[auto_crop] streamlink resolve failed: {e}', file=sys.stderr)
    return source


def extract_sample_frames(source: str, count: int = 10, width: int = 1920, height: int = 1080) -> list[np.ndarray]:
    """Extract evenly-spaced sample frames from a video source.

    For Twitch VODs, resolves the direct URL once and uses ffmpeg with fast seeking.

    Args:
        source: Video file path or URL (Twitch VOD, etc.).
        count: Number of evenly-spaced frames to extract.
        width: Expected video width (used for raw-frame decoding). If 0 or
            if ffmpeg output doesn't match, auto-detection is attempted
            via ffprobe then OpenCV.
        height: Expected video height.
    """
    # Resolve Twitch VODs to a direct URL for fast seeking
    direct_url = _resolve_stream_url(source)

    # Auto-detect resolution when defaults may be wrong.
    detected = _probe_resolution(direct_url)
    if detected is not None:
        width, height = detected

    # Get video duration
    duration = _probe_duration(direct_url)

    if duration is None or duration <= 0:
        # Can't determine duration — grab frames from early in the video
        timestamps = [10.0 + i * 30.0 for i in range(count)]
    else:
        # Evenly space frames, skipping first/last 5%
        start = duration * 0.05
        end = duration * 0.95
        step = (end - start) / max(count - 1, 1)
        timestamps = [start + i * step for i in range(count)]

    frames: list[np.ndarray] = []
    for ts in timestamps:
        print(f'[auto_crop] Extracting frame at {ts:.1f}s...', file=sys.stderr)
        frame = _extract_single_frame(direct_url, ts, width, height)
        if frame is not None:
            frames.append(frame)

    return frames


def _probe_resolution(source: str) -> tuple[int, int] | None:
    """Detect video resolution via ffprobe, falling back to OpenCV.

    Returns (width, height) or None if detection fails entirely.
    """
    # Method 1: ffprobe (fast, works with URLs)
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height', '-of', 'json', source],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            import json
            data = json.loads(result.stdout)
            streams = data.get('streams', [])
            if streams:
                w = int(streams[0]['width'])
                h = int(streams[0]['height'])
                if w > 0 and h > 0:
                    return (w, h)
    except Exception:
        pass

    # Method 2: OpenCV VideoCapture (works without ffprobe, local files)
    try:
        cap = cv2.VideoCapture(source)
        if cap.isOpened():
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            cap.release()
            if w > 0 and h > 0:
                return (w, h)
    except Exception:
        pass

    return None


def _probe_duration(source: str) -> float | None:
    """Get video duration in seconds."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', source],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except Exception:
        pass
    return None


def _extract_single_frame(
    source: str, timestamp: float, width: int, height: int,
) -> np.ndarray | None:
    """Extract a single frame at the given timestamp using fast seeking."""
    frame_size = width * height * 3

    try:
        # -ss before -i enables fast seeking (input seeking)
        result = subprocess.run(
            ['ffmpeg', '-hide_banner', '-loglevel', 'error',
             '-ss', str(timestamp),
             '-i', source,
             '-vframes', '1',
             '-pix_fmt', 'bgr24', '-vcodec', 'rawvideo',
             '-f', 'rawvideo', 'pipe:1'],
            capture_output=True, timeout=30,
        )
        raw = result.stdout

        if len(raw) >= frame_size:
            return np.frombuffer(raw[:frame_size], dtype=np.uint8).reshape((height, width, 3))
    except Exception as e:
        print(f'[auto_crop] Failed to extract frame at {timestamp:.1f}s: {e}', file=sys.stderr)

    return None


def is_likely_gameplay(frame: np.ndarray) -> bool:
    """Check if a frame likely shows NES Zelda 1 gameplay.

    Heuristic: dark HUD strip in top 25% + brighter game area below.
    Rejects mostly-black frames (transitions) and uniform frames (title).

    Args:
        frame: BGR image (any resolution).

    Returns:
        True if the frame appears to show gameplay.
    """
    h, w = frame.shape[:2]

    # Reject mostly black frames (transitions, loading)
    overall = float(np.mean(frame))
    if overall < 10:
        return False

    # Reject mostly uniform frames (title screens, solid backgrounds)
    std = float(np.std(frame))
    if std < 15:
        return False

    # Check for dark HUD strip in top 25% and brighter area below
    hud_strip = frame[:h // 4, :, :]
    game_strip = frame[h // 4:, :, :]
    hud_bright = float(np.mean(hud_strip))
    game_bright = float(np.mean(game_strip))

    return hud_bright < 80 and game_bright > hud_bright and game_bright > 20


def filter_gameplay_frames(frames: list[np.ndarray]) -> list[np.ndarray]:
    """Filter frame list to keep only likely gameplay frames.

    Returns the filtered list, or the original list if fewer than 2 frames pass.
    """
    filtered = [f for f in frames if is_likely_gameplay(f)]
    return filtered if len(filtered) >= 2 else frames


def _find_level_text(canonical: np.ndarray, dx: int, dy: int) -> float:
    """Check for LEVEL-X text as secondary calibration anchor.

    In dungeons, "LEVEL-X" appears at fixed NES position (upper-left of game area).
    The text is white/bright and the "L" starts at roughly col 2, row 9 of the
    canonical frame.

    Returns a score (0.0 = not found, positive = found).
    """
    # LEVEL text region: approximately row 9-10, cols 2-8
    row, col_start = 9, 2
    score = 0.0

    for col in range(col_start, col_start + 5):
        x = col * 8 + dx
        y = row * 8 + dy
        if x + 8 > 256 or y + 8 > 240:
            continue
        tile = canonical[y:y + 8, x:x + 8]
        brightness = float(np.mean(tile))
        # LEVEL text is bright white against dark dungeon background
        if brightness > 80:
            score += 0.1

    return score


def _find_hearts_pattern(canonical: np.ndarray, dx: int, dy: int) -> float:
    """Check for hearts row pattern as tertiary calibration anchor.

    Hearts appear as red dots in the HUD at rows 3-4, cols 22-29.
    Returns a score (0.0 = no hearts, positive = hearts found).
    """
    score = 0.0

    # Hearts span cols 22-29, rows 3-4
    for row in [3, 4]:
        red_count = 0
        for col in range(22, 30):
            x = col * 8 + dx
            y = row * 8 + dy
            if x + 8 > 256 or y + 8 > 240:
                continue
            tile = canonical[y:y + 8, x:x + 8]
            avg = np.mean(tile, axis=(0, 1))
            r, g, b = float(avg[2]), float(avg[1]), float(avg[0])
            if r > 60 and r > g * 1.3:
                red_count += 1

        if red_count >= 3:
            score += 0.3
            break  # one row is enough

    return score


def multi_anchor_calibration(canonical: np.ndarray) -> dict | None:
    """Score a canonical frame using multiple calibration anchors.

    Uses LIFE text (primary), LEVEL-X text (secondary), and hearts pattern
    (tertiary) to find the best grid offset. Returns the best result or None.
    """
    best_result = None
    best_total = 0.0

    for dy in range(8):
        for dx in range(8):
            # Primary: LIFE text score
            life_score = _score_calibration(canonical, dx, dy)

            # Secondary: LEVEL-X text
            level_score = _find_level_text(canonical, dx, dy)

            # Tertiary: hearts pattern
            hearts_score = _find_hearts_pattern(canonical, dx, dy)

            total = life_score + level_score + hearts_score
            if total > best_total:
                best_total = total
                best_result = {
                    'dx': dx,
                    'dy': dy,
                    'score': total,
                    'life_score': life_score,
                    'level_score': level_score,
                    'hearts_score': hearts_score,
                }

    if best_result and best_result['score'] > 0.5:
        return best_result
    return None


def _detect_with_fallback(detector: AutoCropDetector, frames: list[np.ndarray]) -> dict | None:
    """Run contour detection first, then LIFE-text calibration as fallback.

    Returns a dict with crop, grid_offset, confidence, method, hud_verified
    or None if no detection succeeds.
    """
    # Pre-filter: keep only gameplay frames for better detection
    gameplay_frames = filter_gameplay_frames(frames)
    if len(gameplay_frames) > len(frames) // 2:
        print(f'[auto_crop] Filtered {len(frames)} frames to {len(gameplay_frames)} gameplay frames', file=sys.stderr)
        frames = gameplay_frames

    # Phase 1: Multi-frame contour detection
    result = detector.detect_crop_multi(frames)
    if result is not None and result.confidence >= 0.5 and result.hud_verified:
        print(f'[auto_crop] Contour detection succeeded (confidence: {result.confidence:.2f})', file=sys.stderr)
        # Get grid offset from the detected crop
        best_frame = frames[len(frames) // 2]
        region = best_frame[result.y:result.y + result.h, result.x:result.x + result.w]
        if region.size > 0:
            canonical = cv2.resize(region, (256, 240), interpolation=cv2.INTER_NEAREST)
            # Try multi-anchor calibration first, fall back to LIFE-only
            multi = multi_anchor_calibration(canonical)
            if multi:
                offset = (multi['dx'], multi['dy'])
            else:
                offset = find_grid_offset(canonical)
        else:
            offset = None
        return {
            'crop': {'x': result.x, 'y': result.y, 'w': result.w, 'h': result.h},
            'grid_offset': {'dx': offset[0] if offset else 0, 'dy': offset[1] if offset else 0},
            'confidence': result.confidence,
            'method': 'contour',
            'hud_verified': result.hud_verified,
        }

    # Phase 2: LIFE-text calibration fallback
    print('[auto_crop] Contour detection insufficient, trying LIFE-text calibration...', file=sys.stderr)
    best_life = None
    best_life_score = 0.0
    for i, frame in enumerate(frames):
        cal = calibrate_from_life_text(frame)
        if cal is not None and cal['confidence'] > best_life_score:
            best_life_score = cal['confidence']
            best_life = cal
            print(f'[auto_crop] LIFE-text found in frame {i} (confidence: {cal["confidence"]:.2f})', file=sys.stderr)

    if best_life is not None and best_life['confidence'] >= 0.3:
        cx, cy, cw, ch = best_life['crop']
        dx, dy = best_life['grid_offset']
        return {
            'crop': {'x': cx, 'y': cy, 'w': cw, 'h': ch},
            'grid_offset': {'dx': dx, 'dy': dy},
            'confidence': best_life['confidence'],
            'method': 'life_text',
            'hud_verified': True,
        }

    # Phase 3: Try common layout library
    print('[auto_crop] Trying common stream layouts...', file=sys.stderr)
    layout_result = try_common_layouts(frames)
    if layout_result is not None:
        print(f'[auto_crop] Layout match: {layout_result["method"]} '
              f'(confidence: {layout_result["confidence"]:.2f})', file=sys.stderr)
        return layout_result

    # Phase 4: Use contour result even if low confidence (better than nothing)
    if result is not None:
        print(f'[auto_crop] Falling back to low-confidence contour result ({result.confidence:.2f})', file=sys.stderr)
        return {
            'crop': {'x': result.x, 'y': result.y, 'w': result.w, 'h': result.h},
            'grid_offset': {'dx': 0, 'dy': 0},
            'confidence': result.confidence,
            'method': 'contour_low',
            'hud_verified': result.hud_verified,
        }

    return None


def try_common_layouts(frames: list[np.ndarray],
                       layouts_path: str = 'data/common-crop-layouts.json',
                       ) -> dict | None:
    """Try standard stream layouts as last-resort fallback.

    Loads common layout definitions, tests each against the provided frames,
    and returns the best-scoring one. Only used when auto-crop and LIFE-text
    calibration both fail.

    Args:
        frames: List of BGR stream frames.
        layouts_path: Path to the common layouts JSON file.

    Returns:
        Detection dict (crop, grid_offset, confidence, method) or None.
    """
    import os
    if not os.path.isfile(layouts_path):
        return None

    with open(layouts_path) as f:
        data = json.load(f)

    layouts = data.get('layouts', [])
    if not layouts or not frames:
        return None

    h, w = frames[0].shape[:2]
    best = None
    best_score = 0.0

    for layout in layouts:
        # Only try layouts matching the stream resolution
        if layout['streamWidth'] != w or layout['streamHeight'] != h:
            continue

        crop = layout['crop']
        cx, cy, cw, ch = crop['x'], crop['y'], crop['w'], crop['h']

        # Validate bounds
        if cx + cw > w or cy + ch > h or cw < 100 or ch < 100:
            continue

        # Score this layout across multiple frames
        total_score = 0.0
        scored_frames = 0

        for frame in frames[:5]:
            region = frame[cy:cy + ch, cx:cx + cw]
            if region.size == 0:
                continue
            canonical = cv2.resize(region, (256, 240), interpolation=cv2.INTER_NEAREST)
            cal = multi_anchor_calibration(canonical)
            if cal:
                total_score += cal['score']
                scored_frames += 1

        if scored_frames > 0:
            avg_score = total_score / scored_frames
            if avg_score > best_score:
                best_score = avg_score
                # Get grid offset from best-scoring calibration
                region = frames[0][cy:cy + ch, cx:cx + cw]
                canonical = cv2.resize(region, (256, 240), interpolation=cv2.INTER_NEAREST)
                cal = multi_anchor_calibration(canonical)
                offset = (cal['dx'], cal['dy']) if cal else (0, 0)

                best = {
                    'crop': {'x': cx, 'y': cy, 'w': cw, 'h': ch},
                    'grid_offset': {'dx': offset[0], 'dy': offset[1]},
                    'confidence': min(avg_score / 2.0, 0.7),  # cap at 0.7 for layout match
                    'method': f'layout:{layout["id"]}',
                    'hud_verified': avg_score > 0.8,
                }

    return best


def main():
    parser = argparse.ArgumentParser(description='Auto-detect NES game region')
    parser.add_argument('--input', help='Path to a frame image (PNG/JPG)')
    parser.add_argument('--inputs', help='Comma-separated paths to multiple frame images')
    parser.add_argument('--source', help='Video source (file path, URL, or Twitch VOD URL)')
    parser.add_argument('--sample-count', type=int, default=10, help='Number of frames to sample')
    parser.add_argument('--width', type=int, default=1920, help='Source frame width')
    parser.add_argument('--height', type=int, default=1080, help='Source frame height')
    args = parser.parse_args()

    detector = AutoCropDetector()

    if args.inputs:
        # Multi-file mode: read local images, run detection with fallback chain
        paths = [p.strip() for p in args.inputs.split(',') if p.strip()]
        frames = []
        for p in paths:
            frame = cv2.imread(p)
            if frame is not None:
                frames.append(frame)
            else:
                print(f'[auto_crop] Warning: could not read {p}', file=sys.stderr)
        if not frames:
            print(json.dumps({'error': 'No valid images could be read'}))
            sys.exit(1)
        print(f'[auto_crop] Loaded {len(frames)} frames, running detection chain...', file=sys.stderr)
        output = _detect_with_fallback(detector, frames)
        if output is None:
            print(json.dumps({'crop': None}))
        else:
            print(json.dumps(output))
        return

    if args.input:
        frame = cv2.imread(args.input)
        if frame is None:
            print(f'Error: could not read {args.input}', file=sys.stderr)
            sys.exit(1)
        result = detector.detect_crop(frame)
    elif args.source:
        print(f'Extracting {args.sample_count} sample frames...', file=sys.stderr)
        frames = extract_sample_frames(args.source, args.sample_count, args.width, args.height)
        if not frames:
            print('Error: could not extract any frames', file=sys.stderr)
            sys.exit(1)
        print(f'Got {len(frames)} frames, running detection...', file=sys.stderr)
        result = detector.detect_crop_multi(frames)
    else:
        parser.error('Either --input, --inputs, or --source is required')
        return

    if result is None:
        print(json.dumps({'error': 'No NES game region detected'}))
        sys.exit(1)

    print(json.dumps(result.to_dict(), indent=2))


if __name__ == '__main__':
    main()
