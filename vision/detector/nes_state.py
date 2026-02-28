"""Top-level NES game state aggregator.

Orchestrates all sub-detectors to produce a complete game state
from a single 256x240 NES frame.
"""

from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np

from .auto_crop import find_grid_alignment
from .screen_classifier import ScreenClassifier
from .hud_reader import HudReader
from .digit_reader import DigitReader
from .item_reader import ItemReader
from .inventory_reader import InventoryReader
from .triforce_reader import TriforceReader
from .floor_item_detector import FloorItemDetector
from .ganon_detector import GanonDetector
from .item_detector import ItemDetector
from .hud_calibrator import HudCalibrator
from .minimap_reader import MinimapReader


@dataclass
class GameState:
    """Complete detected NES Zelda 1 game state."""
    screen_type: str = 'unknown'       # overworld, dungeon, cave, subscreen, death, title
    dungeon_level: int = 0             # 0=overworld, 1-9=dungeon
    hearts_current: int = 0
    hearts_max: int = 3
    has_half_heart: bool = False
    rupees: int = 0
    keys: int = 0
    bombs: int = 0
    b_item: Optional[str] = None
    sword_level: int = 0               # 0=none, 1=wood, 2=white, 3=magical
    has_master_key: bool = False        # "A" displayed at key position
    gannon_nearby: bool = False         # -ROAR- instead of -LIFE-
    bomb_max: int = 8                   # inferred max capacity (8/12/16)
    items: dict = field(default_factory=dict)       # item_name -> True/False
    triforce: list = field(default_factory=lambda: [False] * 8)  # 8 pieces
    map_position: int = 0              # NES room byte
    detected_item: Optional[str] = None  # item sprite visible in game area
    detected_item_y: int = 0             # y position in game area (0=top)
    floor_items: list = field(default_factory=list)  # FloorItem dicts on floor
    dungeon_map_rooms: int | None = None        # bitmask; None until map acquired
    triforce_room: tuple | None = None           # (col,row); None until compass
    zelda_room: tuple | None = None              # L9 only: Zelda's room
    tile_match_id: int | None = None             # OW tile recognition result
    tile_match_score: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, GameState):
            return False
        return self.to_dict() == other.to_dict()


class NesStateDetector:
    """Orchestrates sub-detectors to extract full game state from a NES frame.

    Args:
        template_dir: Path to the templates/ directory with reference sprites.
    """

    def __init__(self, template_dir: str = 'templates', grid_offset: tuple[int, int] = (1, 2),
                 life_row: int = 5, landmarks: list[dict] | None = None):
        self.calibrator = HudCalibrator()
        self.screen_classifier = ScreenClassifier(grid_offset=grid_offset, life_row=life_row)
        self.hud_reader = HudReader(grid_offset=grid_offset, life_row=life_row,
                                     landmarks=landmarks, calibrator=self.calibrator)
        self.digit_reader = DigitReader(f'{template_dir}/digits')
        self.item_reader = ItemReader(f'{template_dir}/items')
        self.inventory_reader = InventoryReader()
        self.triforce_reader = TriforceReader(grid_offset=grid_offset)
        self.item_detector = ItemDetector(item_reader=self.item_reader)
        self.floor_item_detector = FloorItemDetector(
            item_reader=self.item_reader,
            drops_dir=f'{template_dir}/drops',
        )
        self.ganon_detector = GanonDetector(f'{template_dir}/enemies')
        self.minimap = MinimapReader(calibrator=self.calibrator)
        # Deferred import to avoid circular dependency (game_logic imports GameState)
        from .game_logic import PlayerItemTracker, RaceItemTracker
        self.player_items = PlayerItemTracker()
        self.race_items = RaceItemTracker()

    def _set_grid_offset(self, dx: int, dy: int) -> None:
        """Update grid offset on all sub-detectors that use tile positions."""
        self.screen_classifier.grid_dx = dx
        self.screen_classifier.grid_dy = dy
        self.hud_reader.grid_dx = dx
        self.hud_reader.grid_dy = dy
        self.triforce_reader.grid_dx = dx
        self.triforce_reader.grid_dy = dy

    def _refine_grid(self, frame: np.ndarray, initial_dx: int, initial_dy: int) -> tuple[int, int]:
        """Refine (dx, dy) using digit template matches across multiple HUD rows.

        find_grid_alignment uses LIFE text redness which can be ambiguous on
        frames resized from non-native resolution (red bleeds ±1px). Digit
        templates are sharper discriminators of the correct offset.

        Quality metric: minimum of the per-row average digit score across
        sampled HUD rows (rupees row 2, level row 1, keys row 4, bombs row 5).
        Using the minimum prevents a single high-scoring row (e.g. three rupee
        digits) from overriding dy when other rows disagree.

        dy is searched in a ±1 window around the initial estimate.
        """
        # (cols_to_sample, row_index)
        # Row 5 (bombs/LIFE) is intentionally excluded: on streams with a 4.5×
        # vertical scale (1080÷240), the bomb digit sits 1px lower than the
        # global grid offset predicts, causing it to score poorly at the correct
        # dy.  Rows 1, 2, 4 are consistently aligned and give reliable dy signal.
        _ROW_SPECS = (
            ((12, 13, 14), 2),   # rupees (3 cols)
            ((8,),         1),   # dungeon level
            ((13,),        4),   # keys
        )
        best_dx = initial_dx
        best_dy = initial_dy
        best_score = -1.0
        dy_lo = max(0, initial_dy - 1)
        dy_hi = min(8, initial_dy + 2)
        for candidate_dy in range(dy_lo, dy_hi):
            for candidate_dx in range(8):
                row_avgs = []
                for cols, row in _ROW_SPECS:
                    row_total = 0.0
                    row_count = 0
                    for col in cols:
                        x = col * 8 + candidate_dx
                        y = row * 8 + candidate_dy
                        if x + 8 > 256 or y + 8 > 240:
                            continue
                        tile = frame[y:y + 8, x:x + 8]
                        if float(np.mean(tile)) < 10:
                            continue
                        _, score = self.digit_reader.read_digit_with_score(tile)
                        row_total += score
                        row_count += 1
                    if row_count > 0:
                        row_avgs.append(row_total / row_count)
                if not row_avgs:
                    continue
                # Use minimum per-row average: any misaligned row pulls score down
                quality = min(row_avgs)
                if quality > best_score:
                    best_score = quality
                    best_dx = candidate_dx
                    best_dy = candidate_dy
        return best_dx, best_dy

    def detect(self, frame: np.ndarray) -> GameState:
        """Detect game state from a canonical 256x240 BGR NES frame.

        Args:
            frame: numpy array of shape (240, 256, 3) in BGR color space.

        Returns:
            GameState with all detected fields.
        """
        state = GameState()

        # Auto-calibrate grid offset when no landmarks are configured.
        # In production, landmarks from crop calibration provide the offset.
        # For standalone use (golden frames, one-off detection), auto-detect.
        if not self.hud_reader._has_landmark('-LIFE-'):
            alignment = find_grid_alignment(frame)
            if alignment:
                dx, dy, _ = alignment
                dx, dy = self._refine_grid(frame, dx, dy)
                self._set_grid_offset(dx, dy)

        # Classify screen type
        state.screen_type = self.screen_classifier.classify(frame)

        # Safety correction: if classified as non-gameplay but HUD is present,
        # reclassify. This catches edge cases the classifier might miss.
        if (state.screen_type not in ('overworld', 'dungeon', 'cave')
                and self.hud_reader.is_hud_present(frame)):
            game_area = frame[64:240, :, :]
            avg_brightness = float(np.mean(game_area))
            if avg_brightness < 35:
                state.screen_type = 'dungeon'
            elif avg_brightness < 55:
                state.screen_type = 'cave'
            else:
                state.screen_type = 'overworld'

        # Read HUD elements (only when the Zelda HUD is actually present).
        if (state.screen_type in ('overworld', 'dungeon', 'cave')
                and self.hud_reader.is_hud_present(frame)):
            # NOTE: HudCalibrator is designed for native-resolution frames
            # (set_native_frame path). On canonical 256x240 frames,
            # _detect_life_text misidentifies life_y (picks up rupee/heart
            # red pixels at y=18 instead of LIFE text at y=40), producing
            # wrong scale factors. Calibration is skipped here; it runs
            # when native frames are available via set_native_frame().

            # Read dungeon level — can correct screen_type for bright dungeons.
            # read_dungeon_level() now includes a saturation check to reject
            # overworld minimap pixels (colored) vs real LEVEL text (white).
            raw_level = self.hud_reader.read_dungeon_level(
                frame, self.digit_reader)
            if raw_level > 0:
                state.dungeon_level = raw_level
                state.screen_type = 'dungeon'

            hearts = self.hud_reader.read_hearts(frame)
            state.hearts_current = hearts[0]
            state.hearts_max = hearts[1]
            state.has_half_heart = hearts[2]

            state.rupees = self.hud_reader.read_rupees(frame, self.digit_reader)
            keys_count, has_master_key = self.hud_reader.read_keys(frame, self.digit_reader)
            state.keys = keys_count
            state.has_master_key = has_master_key
            state.bombs = self.hud_reader.read_bombs(frame, self.digit_reader)

            # Sword and B-item from HUD (visible during gameplay)
            state.sword_level = self.hud_reader.read_sword(frame)
            state.b_item = self.hud_reader.read_b_item(frame, self.item_reader)

            # Update player item tracking
            self.player_items.update_from_b_item(state.b_item)
            self.player_items.update_sword_level(state.sword_level)

            # LIFE/ROAR detection (Gannon proximity)
            state.gannon_nearby = self.hud_reader.read_life_roar(frame)

            # Fallback: sprite-based Ganon detection when ROAR is unreliable
            if not state.gannon_nearby:
                state.gannon_nearby = self.ganon_detector.detect(
                    frame, state.screen_type, state.dungeon_level)

            # Minimap position (proven working on canonical frames)
            is_dungeon = state.screen_type == 'dungeon'
            state.map_position = self.hud_reader.read_minimap_position(frame, is_dungeon)

            # MinimapReader provides extra fields (dungeon map, triforce/zelda
            # room dots) but its grid derivation depends on calibrator anchors.
            # Only use it when calibrator is locked (native-resolution path).
            if self.calibrator.result.locked:
                minimap_result = self.minimap.read(frame, state.screen_type, state.dungeon_level)
                state.dungeon_map_rooms = minimap_result.dungeon_map_rooms
                state.triforce_room = minimap_result.triforce_room
                state.zelda_room = minimap_result.zelda_room
                state.tile_match_id = minimap_result.tile_match_id
                state.tile_match_score = minimap_result.tile_match_score

            # Item detection in game area (triforce pieces, etc.)
            items = self.item_detector.detect_items(frame, state.screen_type)
            if items:
                best = items[0]
                state.detected_item = best.item_type
                state.detected_item_y = best.y

            # Floor item detection (dungeon/overworld only)
            floor_items = self.floor_item_detector.detect(frame, state.screen_type)
            state.floor_items = [
                {'name': fi.name, 'x': fi.x, 'y': fi.y, 'score': fi.score}
                for fi in floor_items
            ]

        # Subscreen: read inventory and triforce
        if state.screen_type == 'subscreen':
            state.items = self.inventory_reader.read_items(frame)
            state.triforce = self.triforce_reader.read_triforce(frame)
            state.b_item = self.inventory_reader.read_b_item(frame)
            # Note: sword_level is NOT read from the inventory reader — its
            # SWORD_REGION (24, 152) misreads dungeon subscreens (hits COMPASS
            # area).  The HUD reader's sword detection is authoritative.

        return state

    def set_native_frame(self, stream_frame: np.ndarray,
                         crop_x: int, crop_y: int,
                         crop_w: int, crop_h: int) -> None:
        """Provide native-resolution frame data to all sub-detectors.

        Call this before detect() on every frame. Enables pixel reads at stream
        resolution (e.g. 960x720) instead of the downscaled 256x240 canonical,
        dramatically improving accuracy by preserving more signal per tile.

        Args:
            stream_frame: Full raw stream frame (H x W x 3 BGR).
            crop_x, crop_y: Top-left of the NES game region in stream pixels.
            crop_w, crop_h: Size of the NES game region in stream pixels.
        """
        scale_x = crop_w / 256.0
        scale_y = crop_h / 240.0

        # HudReader uses the full stream frame (handles negative crop_y padding)
        self.hud_reader.set_stream_source(stream_frame, crop_x, crop_y, crop_w, crop_h)

        # Other detectors use the pre-cropped region
        fh, fw = stream_frame.shape[:2]
        sy1, sy2 = max(0, crop_y), min(fh, crop_y + crop_h)
        sx1, sx2 = max(0, crop_x), min(fw, crop_x + crop_w)
        if sy2 > sy1 and sx2 > sx1:
            nes_region = stream_frame[sy1:sy2, sx1:sx2].copy()
            # Pad if crop extends outside stream frame (e.g. negative crop_y)
            if nes_region.shape[:2] != (crop_h, crop_w):
                padded = np.zeros((crop_h, crop_w, 3), dtype=np.uint8)
                dy_off = sy1 - crop_y
                dx_off = sx1 - crop_x
                padded[dy_off:dy_off + nes_region.shape[0],
                       dx_off:dx_off + nes_region.shape[1]] = nes_region
                nes_region = padded
        else:
            nes_region = np.zeros((crop_h, crop_w, 3), dtype=np.uint8)

        self.screen_classifier.set_native_crop(nes_region, scale_x, scale_y)
        self.triforce_reader.set_native_crop(nes_region, scale_x, scale_y)
        self.inventory_reader.set_native_crop(nes_region, scale_x, scale_y)

    def clear_native_frame(self) -> None:
        """Release all native frame references. Call after detect() on every frame."""
        self.hud_reader.clear_stream_source()
        self.screen_classifier.clear_native_crop()
        self.triforce_reader.clear_native_crop()
        self.inventory_reader.clear_native_crop()
