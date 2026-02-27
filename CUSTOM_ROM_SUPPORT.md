# Feature Requests: Robust Custom ROM Support

This document tracks known limitations and planned features for supporting custom and modified Zelda 1 Randomizer ROMs in the vision engine.

## 1. Master Key ('A' / 'Any Key')
**Affected racer:** `bbqdotgov/finish` (and any Z1R runner who obtains the Master Key)
**Status:** Resolved

- **Root cause:** When a player obtains the Master Key (also known as the "Any Key"), Z1R displays an 'A' character instead of the standard key count. The digit reader's template set currently covers 0–9, and while `hud_reader.py` has some fallback logic to detect the 'A' as the `has_master_key` boolean flag, the raw `keys` value defaults to `0`. Furthermore, the 'A' glyph in Z1R coincidently scored 0.5827 against the '0' digit template, bypassing the fallback logic entirely.
- **Expected detector output today:** `keys=0`, `has_master_key=True` (documented as known limitation in validation JSON for the raw key count)
- **Fix implemented:** Added `read_digit_with_score` to expose the match score, and increased the confidence threshold for legitimate digits to `0.65` (`_DIGIT_CONFIDENT_SCORE = 0.65` in `HudReader`). This prevents the 'A' glyph (score 0.58) from incorrectly matching as a '0', cleanly catching the Master Key condition in the fallback.

## 2. Custom Blue Digits
**Affected racer:** `blessedbe_` (custom sprite ROM)
**Status:** Resolved

- **Root cause:** The custom ROM recolors all HUD counter digits from white to blue. The digit 0 in this ROM has a shape that scores higher against the standard 6 template than the standard 0 template — a false positive caused by palette-induced shape similarity after binary thresholding at a brightness level tuned for white digits. Additionally, converting blue to grayscale significantly darkened the pixels, making them barely pass thresholds.
- **Expected detector output today:** Garbage counter values (e.g., rupees=70 reads as ~676)
- **Fix implemented:** 
  - Changed `digit_reader.py` preprocessing to use the max-channel instead of `cvtColor` grayscale, which perfectly preserves the high-contrast brightness of the blue channel.
  - Replaced the `0` template image with a slightly broader '0' so it doesn't accidentally catch the narrow inner loop of a '6'.
  - Removed grid-snapping from pure landmark `y` coordinates in `hud_reader.py` since `blessedbe_` landmarks did not perfectly align with the grid math, requiring exact alignment.

## 3. Custom Non-Red Hearts
**Affected racer:** `blessedbe_` (custom sprite ROM)
**Status:** Resolved

- **Root cause:** The custom ROM recolors heart containers from red to a non-red palette (likely pink or blue). `_red_ratio()` in `HudReader` specifically tests R > 100 & R > G*1.5 & R > B*1.5 — non-red/warm-pink hearts score 0.0 and are classified as empty containers regardless of fill state. Furthermore, extreme vertical distortion squished the canonical rows so badly that row 1 hearts were duplicating into row 2.
- **Expected detector output today:** `hearts_current=0` regardless of actual HP (all hearts read as empty outlines)
- **Fix implemented:** 
  - Replaced the raw color saturation test with `_sat_ratio()`, which uses `R > 100 AND R > G*1.3 AND R > B*1.3` to catch "warm red/pink", distinguishing custom pink fills from the standard gray empty outlines.
  - Added smart deduplication logic to `read_hearts()` for landmarks: when distortion squishes row 1 into the row 2 reading, it identifies the duplicate content and intelligently counts the actual filled hearts vs empty containers that belong in row 2.
