"""Debug: check key/bomb tile positions in detail."""
import sys, os, subprocess
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from detector.hud_reader import HudReader
from detector.nes_frame import NESFrame, extract_nes_crop

CROP = {"x": 383, "y": 24, "w": 871, "h": 670}
STREAM_W, STREAM_H = 1280, 720
LANDMARKS = [
    {"label": "Rupees", "x": 87, "y": 22, "w": 33, "h": 8},
    {"label": "Keys", "x": 87, "y": 38, "w": 33, "h": 8},
    {"label": "Bombs", "x": 87, "y": 46, "w": 33, "h": 8},
]
VOD_URL = "https://www.twitch.tv/videos/2705396017"


def main():
    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()

    outdir = "debug_keybmb"
    os.makedirs(outdir, exist_ok=True)

    cmd = [
        "ffmpeg", "-ss", "1500", "-i", stream_url,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-v", "error", "pipe:1"
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=30)
    sf = np.frombuffer(proc.stdout, dtype=np.uint8).reshape((STREAM_H, STREAM_W, 3))
    x, y, w, h = CROP["x"], CROP["y"], CROP["w"], CROP["h"]
    nes_region = extract_nes_crop(sf, x, y, w, h)
    scale_x = w / 256.0
    scale_y = h / 240.0
    canonical = cv2.resize(nes_region, (256, 240), interpolation=cv2.INTER_NEAREST)

    # Save the canonical HUD area with annotations
    hud = canonical[0:64, :].copy()
    big = cv2.resize(hud, (256*4, 64*4), interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(f"{outdir}/canonical_hud.png", big)

    # Check canonical pixel values at key positions
    print("=== Canonical frame pixel check ===")
    for name, nes_y in [("rup", 22), ("key", 38), ("bmb", 46)]:
        for col in [12, 13, 14]:
            nes_x = col * 8
            # Check different dx values
            for dx in range(4):
                pixel = canonical[nes_y, nes_x + dx]
                print(f"  {name} y={nes_y} col={col} dx={dx}: "
                      f"canonical[{nes_y},{nes_x+dx}] = {pixel}")

    # Now check with stream source
    print("\n=== Stream source extraction ===")
    for dx in [0, 1, 2]:
        for dy in [6, 7]:
            nf = NESFrame(nes_region, scale_x, scale_y, grid_dx=dx, grid_dy=dy)
            print(f"\n  dx={dx}, dy={dy}:")

            for name, row, nes_y_expected in [
                ("rup_r2", 2, 22), ("key_r4", 4, 38), ("bmb_r5", 5, 46),
                ("key_r3", 3, None), ("bmb_r4", 4, None),
            ]:
                nes_x = 14 * 8 + dx
                nes_y = row * 8 + dy
                tile = nf.extract(nes_x, nes_y, 8, 8)
                mean = float(np.mean(tile))
                print(f"    {name}: tile(14,{row}) -> nes({nes_x},{nes_y}) "
                      f"mean={mean:.1f} "
                      f"pixel_sample={tile[4,4].tolist()}")

                # Save tile
                big_t = cv2.resize(tile, (64, 64), interpolation=cv2.INTER_NEAREST)
                cv2.imwrite(f"{outdir}/{name}_dx{dx}dy{dy}.png", big_t)

    # Also extract key/bomb area directly at landmark positions
    print("\n=== Direct landmark extraction ===")
    nf = NESFrame(nes_region, scale_x, scale_y, grid_dx=1, grid_dy=7)
    for name, lm_y, lm_w in [("key", 38, 33), ("bmb", 46, 33)]:
        for nes_x_start in [87, 104, 112]:
            region = nf.extract(nes_x_start, lm_y, 8, 8)
            mean = float(np.mean(region))
            print(f"  {name} x={nes_x_start} y={lm_y}: mean={mean:.1f} "
                  f"sample={region[4,4].tolist()}")
            big_r = cv2.resize(region, (64, 64), interpolation=cv2.INTER_NEAREST)
            cv2.imwrite(f"{outdir}/direct_{name}_x{nes_x_start}.png", big_r)


if __name__ == "__main__":
    main()
