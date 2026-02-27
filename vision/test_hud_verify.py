"""Verify region-based HUD reading against MFmerks VOD screenshots."""
import sys, os, subprocess
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from detector.hud_reader import HudReader
from detector.digit_reader import DigitReader
from detector.item_reader import ItemReader

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
ITEM_TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates", "items")
TIMESTAMPS = [600, 1500, 2400, 2700]


def main():
    digit_reader = DigitReader(TEMPLATE_DIR)
    item_reader = ItemReader(ITEM_TEMPLATE_DIR)
    hud = HudReader(grid_offset=(0, 0), landmarks=LANDMARKS)

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()
    if not stream_url:
        print(f"ERROR: {proc.stderr}")
        return

    outdir = "verify_hud"
    os.makedirs(outdir, exist_ok=True)

    for ts in TIMESTAMPS:
        cmd = [
            "ffmpeg", "-ss", str(ts), "-i", stream_url,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-v", "error", "pipe:1"
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if len(proc.stdout) != STREAM_W * STREAM_H * 3:
            print(f"t={ts}: SKIP")
            continue

        sf = np.frombuffer(proc.stdout, dtype=np.uint8).reshape((STREAM_H, STREAM_W, 3))
        x, y, w, h = CROP["x"], CROP["y"], CROP["w"], CROP["h"]
        canonical = cv2.resize(sf[y:y+h, x:x+w], (256, 240),
                               interpolation=cv2.INTER_NEAREST)

        hud.set_stream_source(sf, x, y, w, h)

        # Read all values
        hearts, max_h, half = hud.read_hearts(canonical)
        rupees = hud.read_rupees(canonical, digit_reader)
        keys, master = hud.read_keys(canonical, digit_reader)
        bombs = hud.read_bombs(canonical, digit_reader)
        lvl = hud.read_dungeon_level(canonical, digit_reader)
        sword = hud.read_sword(canonical)
        b_item = hud.read_b_item(canonical, item_reader)

        sword_names = {0: "none", 1: "wood", 2: "white", 3: "magical"}

        # Save full HUD at 4x
        hud_area = canonical[0:64, :]
        big = cv2.resize(hud_area, (hud_area.shape[1]*4, hud_area.shape[0]*4),
                         interpolation=cv2.INTER_NEAREST)
        # Annotate with readings
        label = (f"Rup={rupees} Key={keys}{'MK' if master else ''} "
                 f"Bmb={bombs} H={hearts}/{max_h}{'h' if half else ''} "
                 f"LVL={lvl} Sw={sword_names[sword]} B={b_item}")
        cv2.putText(big, f"t={ts}s  {label}", (10, big.shape[0] - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
        cv2.imwrite(f"{outdir}/t{ts}_hud.png", big)

        # Also save the full stream crop for context
        crop_area = sf[y:y+h, x:x+w]
        cv2.imwrite(f"{outdir}/t{ts}_crop.png", crop_area)

        print(f"t={ts}: Rup={rupees} Key={keys}{'(MK)' if master else ''} "
              f"Bmb={bombs} H={hearts}/{max_h}{'h' if half else ''} "
              f"LVL={lvl} Sw={sword_names[sword]} B={b_item}")

        hud.clear_stream_source()

    print(f"\nSaved to {outdir}/")


if __name__ == "__main__":
    main()
