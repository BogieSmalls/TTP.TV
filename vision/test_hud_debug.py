"""Find the correct grid offset for MFmerks by sweeping dx/dy values."""
import sys, os, subprocess
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from detector.hud_reader import HudReader
from detector.digit_reader import DigitReader
from detector.nes_frame import NESFrame, extract_nes_crop

CROP = {"x": 383, "y": 24, "w": 871, "h": 670}
STREAM_W, STREAM_H = 1280, 720
LANDMARKS = [
    {"label": "-LIFE-", "x": 184, "y": 23, "w": 46, "h": 8},
    {"label": "Hearts", "x": 176, "y": 38, "w": 65, "h": 18},
    {"label": "Rupees", "x": 87, "y": 22, "w": 33, "h": 8},
    {"label": "Keys", "x": 87, "y": 38, "w": 33, "h": 8},
    {"label": "Bombs", "x": 87, "y": 46, "w": 33, "h": 8},
    {"label": "B", "x": 123, "y": 22, "w": 18, "h": 32},
    {"label": "A", "x": 147, "y": 22, "w": 18, "h": 32},
    {"label": "Minimap", "x": 16, "y": 23, "w": 65, "h": 32},
    {"label": "LVL", "x": 16, "y": 14, "w": 65, "h": 9},
]
VOD_URL = "https://www.twitch.tv/videos/2705396017"
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates", "digits")

# Expected values from visual inspection:
# t=600: Rup=17, Key=0, Bmb=4, LVL=0
# t=1500: Rup=135, Key=3, Bmb=9, LVL=5

def main():
    digit_reader = DigitReader(TEMPLATE_DIR)

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    # Extract frames at t=600 and t=1500
    frames = {}
    for ts in [600, 1500]:
        cmd = [
            "ffmpeg", "-ss", str(ts), "-i", stream_url,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-v", "error", "pipe:1"
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if len(proc.stdout) == STREAM_W * STREAM_H * 3:
            frames[ts] = np.frombuffer(proc.stdout, dtype=np.uint8).reshape(
                (STREAM_H, STREAM_W, 3))

    x, y, w, h = CROP["x"], CROP["y"], CROP["w"], CROP["h"]

    # Sweep grid offsets
    print("Sweeping grid offsets (dx, dy) with stream source...")
    print("Expected: t=600 Rup=17 Key=0 Bmb=4 | t=1500 Rup=135 Key=3 Bmb=9 LVL=5")
    print()

    best_score = -1
    best_offset = (0, 0)

    hud = HudReader()

    for dy in range(8):
        for dx in range(8):
            # Use standard NES positions (no landmarks, just grid offset on NESFrame)
            results = {}

            for ts, sf in frames.items():
                nf = NESFrame(extract_nes_crop(sf, x, y, w, h),
                              w / 256.0, h / 240.0, grid_dx=dx, grid_dy=dy)
                rup = hud._read_counter_tiles(nf, digit_reader,
                    [12, 13, 14], 2)
                key = hud._read_counter_tiles(nf, digit_reader,
                    [13, 14], 3)
                bmb = hud._read_counter_tiles(nf, digit_reader,
                    [13, 14], 4)
                # Dungeon level
                lvl_tile = nf.tile(8, 1)
                lvl = digit_reader.read_digit(lvl_tile)
                if rup > 255:
                    rup = rup % 100
                results[ts] = (rup, key, bmb, lvl)

            # Score against expected
            r600 = results.get(600, (0, 0, 0, None))
            r1500 = results.get(1500, (0, 0, 0, None))
            score = 0
            if r600[0] == 17: score += 3
            if r600[1] == 0: score += 2
            if r600[2] == 4: score += 2
            if r1500[0] == 135: score += 3
            if r1500[1] == 3: score += 2
            if r1500[2] == 9: score += 2
            if r1500[3] == 5: score += 3

            if score > 0:
                print(f"  dx={dx} dy={dy}: "
                      f"t600=({r600[0]:3d},{r600[1]:2d},{r600[2]:2d}) "
                      f"t1500=({r1500[0]:3d},{r1500[1]:2d},{r1500[2]:2d},L{r1500[3]}) "
                      f"score={score}")

            if score > best_score:
                best_score = score
                best_offset = (dx, dy)

    print(f"\nBest offset: dx={best_offset[0]}, dy={best_offset[1]} (score={best_score})")

    # Now test with the best offset at all timestamps
    print(f"\n--- Full test with dx={best_offset[0]}, dy={best_offset[1]} ---")
    for ts, sf in sorted(frames.items()):
        nf = NESFrame(extract_nes_crop(sf, x, y, w, h),
                      w / 256.0, h / 240.0,
                      grid_dx=best_offset[0], grid_dy=best_offset[1])
        rup = hud._read_counter_tiles(nf, digit_reader, [12, 13, 14], 2)
        key = hud._read_counter_tiles(nf, digit_reader, [13, 14], 3)
        bmb = hud._read_counter_tiles(nf, digit_reader, [13, 14], 4)
        lvl_tile = nf.tile(8, 1)
        lvl = digit_reader.read_digit(lvl_tile)
        # Sword
        sword_tile = nf.tile(19, 3)
        sw_avg = np.mean(sword_tile, axis=(0, 1))
        sw_b = float(np.mean(sw_avg))
        sw = 3 if sw_avg[0] > sw_avg[2] + 20 else (2 if sw_b > 160 else (1 if sw_b > 15 else 0))
        names = {0: "none", 1: "wood", 2: "white", 3: "magical"}
        if rup > 255:
            rup = rup % 100
        print(f"  t={ts}: Rup={rup} Key={key} Bmb={bmb} LVL={lvl} Sw={names[sw]}")


if __name__ == "__main__":
    main()
