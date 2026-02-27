"""Verify strip-based counter reading against MFmerks VOD ground truth."""
import sys, os, subprocess
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from detector.hud_reader import HudReader
from detector.digit_reader import DigitReader

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

# Ground truth: {timestamp: (rupees, keys, bombs)}
GROUND_TRUTH = {
    600:  (17,  0, 4),
    1500: (135, 3, 9),
    2400: (255, 6, 9),
    2700: (249, 5, 3),
}


def main():
    digit_reader = DigitReader(TEMPLATE_DIR)
    hud = HudReader(grid_offset=(0, 0), landmarks=LANDMARKS)

    # Verify new landmark attrs exist
    assert hasattr(hud, '_rupee_lm'), "Missing _rupee_lm"
    assert hasattr(hud, '_key_lm'), "Missing _key_lm"
    assert hasattr(hud, '_bomb_lm'), "Missing _bomb_lm"
    print(f"Grid offset: dx={hud.grid_dx}, dy={hud.grid_dy}")
    print(f"Rupee lm: {hud._rupee_lm}")
    print(f"Key lm: {hud._key_lm}")
    print(f"Bomb lm: {hud._bomb_lm}")

    proc = subprocess.run(
        ["streamlink", "--stream-url", VOD_URL, "best"],
        capture_output=True, text=True, timeout=30
    )
    stream_url = proc.stdout.strip()
    if not stream_url:
        print("ERROR: streamlink failed to resolve VOD URL")
        return

    passed = 0
    failed = 0
    for ts, (exp_rup, exp_key, exp_bmb) in sorted(GROUND_TRUTH.items()):
        cmd = [
            "ffmpeg", "-ss", str(ts), "-i", stream_url,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-v", "error", "pipe:1"
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if len(proc.stdout) != STREAM_W * STREAM_H * 3:
            print(f"t={ts}: SKIP (frame size mismatch: {len(proc.stdout)})")
            continue

        sf = np.frombuffer(proc.stdout, dtype=np.uint8).reshape((STREAM_H, STREAM_W, 3))
        x, y, w, h = CROP["x"], CROP["y"], CROP["w"], CROP["h"]
        canonical = cv2.resize(sf[y:y+h, x:x+w], (256, 240), interpolation=cv2.INTER_NEAREST)

        # Test with stream source (primary path)
        hud.set_stream_source(sf, x, y, w, h)
        rup = hud.read_rupees(canonical, digit_reader)
        key_count, master = hud.read_keys(canonical, digit_reader)
        bmb = hud.read_bombs(canonical, digit_reader)
        hud.clear_stream_source()

        # Also test canonical-only path
        rup_c = hud.read_rupees(canonical, digit_reader)
        key_c, _ = hud.read_keys(canonical, digit_reader)
        bmb_c = hud.read_bombs(canonical, digit_reader)

        status_rup = "OK" if rup == exp_rup else f"FAIL(got {rup})"
        status_key = "OK" if key_count == exp_key else f"FAIL(got {key_count})"
        status_bmb = "OK" if bmb == exp_bmb else f"FAIL(got {bmb})"

        all_ok = (rup == exp_rup and key_count == exp_key and bmb == exp_bmb)
        if all_ok:
            passed += 1
        else:
            failed += 1

        print(f"\nt={ts}s expected: rup={exp_rup}, key={exp_key}, bmb={exp_bmb}")
        print(f"  stream:    rup={rup} {status_rup}, key={key_count} {status_key}, bmb={bmb} {status_bmb}")
        print(f"  canonical: rup={rup_c}, key={key_c}, bmb={bmb_c}")

    print(f"\n{'='*40}")
    print(f"Results: {passed} passed, {failed} failed out of {passed+failed}")
    if failed == 0:
        print("ALL TESTS PASSED")
    else:
        print("SOME TESTS FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()
