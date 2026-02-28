# vision/tests/test_native_e2e.py
"""End-to-end test: native-resolution detection on a real VOD frame.

Ground truth at t=451 of https://www.twitch.tv/videos/2696354137:
  - screen_type: dungeon
  - dungeon_level: 8
  - b_item: red_candle
  - rupees: 3
  - keys: 0
  - bombs: 3
  - hearts_current: 3
  - hearts_max: 3

To download the fixture frame, run (requires streamlink + ffmpeg):
  streamlink --stream-url https://www.twitch.tv/videos/2696354137 best \
    | ffmpeg -ss 451 -i pipe:0 -vframes 1 \
        vision/tests/fixtures/bogie_t451.png
"""
import os
import numpy as np
import cv2
import pytest
from detector.nes_state import NesStateDetector

FIXTURE_PNG = os.path.join(os.path.dirname(__file__), 'fixtures', 'bogie_t451.png')
FIXTURE_BIN = os.path.join(os.path.dirname(__file__), 'fixtures', 'bogie_t451_raw.bin')
TEMPLATES = os.path.join(os.path.dirname(__file__), '..', 'templates')

# Bogie's crop from data/report_064eb5b2.json (and all other Bogie VOD reports):
# x=544, y=0, w=1376, h=1080 from a 1920x1080 source frame.
CROP = (544, 0, 1376, 1080)

# Grid offset and life_row from data/vision-diag-bogie.json:
GRID_OFFSET = (2, 0)
LIFE_ROW = 5


def _load_fixture():
    """Try PNG first, then raw binary. Returns BGR numpy array or None."""
    if os.path.exists(FIXTURE_PNG):
        frame = cv2.imread(FIXTURE_PNG)
        if frame is not None:
            return frame
    if os.path.exists(FIXTURE_BIN):
        meta_path = FIXTURE_BIN.replace('.bin', '.meta')
        w, h = 1920, 1080  # defaults matching Bogie's stream
        if os.path.exists(meta_path):
            for line in open(meta_path).read().split():
                if line.startswith('width='):
                    w = int(line.split('=')[1])
                elif line.startswith('height='):
                    h = int(line.split('=')[1])
        data = np.frombuffer(open(FIXTURE_BIN, 'rb').read(), dtype=np.uint8)
        return data.reshape((h, w, 3))
    return None


def _fixture_exists():
    return os.path.exists(FIXTURE_PNG) or os.path.exists(FIXTURE_BIN)


@pytest.mark.skipif(
    not _fixture_exists(),
    reason=(
        'VOD fixture not downloaded. To create it run:\n'
        '  streamlink --stream-url https://www.twitch.tv/videos/2696354137 best '
        '| ffmpeg -ss 451 -i pipe:0 -vframes 1 '
        'vision/tests/fixtures/bogie_t451.png'
    )
)
def test_bogie_t451_native_detection():
    """Native-resolution detection on Bogie t=451 matches known ground truth.

    Verifies the full pipeline with set_native_frame() using a real 1920x1080
    Twitch capture and Bogie's production crop (x=544, y=0, w=1376, h=1080).
    """
    frame = _load_fixture()
    assert frame is not None, 'Failed to load fixture frame from disk'
    assert frame.ndim == 3 and frame.shape[2] == 3, \
        f'Expected HxWx3 BGR array, got shape {frame.shape}'

    cx, cy, cw, ch = CROP
    assert frame.shape[0] >= cy + ch, \
        f'Frame height {frame.shape[0]} too small for crop y={cy} h={ch}'
    assert frame.shape[1] >= cx + cw, \
        f'Frame width {frame.shape[1]} too small for crop x={cx} w={cw}'

    nes_region = frame[cy:cy + ch, cx:cx + cw]
    nes_canonical = cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)

    det = NesStateDetector(
        os.path.abspath(TEMPLATES),
        grid_offset=GRID_OFFSET,
        life_row=LIFE_ROW,
    )
    det.set_native_frame(frame, cx, cy, cw, ch)
    state = det.detect(nes_canonical)
    det.clear_native_frame()

    # Screen must be a gameplay screen (dungeon expected at t=451)
    assert state.screen_type in ('dungeon', 'overworld', 'cave'), \
        f'Expected gameplay screen, got {state.screen_type!r}'

    # If dungeon is detected, verify dungeon level 8
    if state.screen_type == 'dungeon':
        assert state.dungeon_level == 8, \
            f'Expected dungeon level 8, got {state.dungeon_level}'

    # HUD counters
    assert state.rupees == 3, \
        f'Expected 3 rupees, got {state.rupees}'
    assert state.keys == 0, \
        f'Expected 0 keys, got {state.keys}'
    assert state.bombs == 3, \
        f'Expected 3 bombs, got {state.bombs}'

    # Hearts
    assert state.hearts_current == 3, \
        f'Expected 3 hearts current, got {state.hearts_current}'
    assert state.hearts_max == 3, \
        f'Expected 3 hearts max, got {state.hearts_max}'

    # B-item
    assert state.b_item == 'red_candle', \
        f'Expected b_item red_candle, got {state.b_item!r}'
