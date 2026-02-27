# Vision Engine Capabilities

The vision engine is the core data extraction layer for the TTPRestream application. After the extensive "Vision Engine Refactor" and "Robust Custom ROM Support" milestones, it is incredibly powerful and resilient.
 
 Here is a comprehensive breakdown of what the engine can do reliably, what it can do with assistance (via crop profiles), and its known hard limitations. This document serves as the ground-truth for understanding the boundaries of our vision component, allowing us to build the rest of the platform (backend/frontend) around these established constraints.
 
 ---
 
 ## 🏗️ Platform Integration Strategy
 As project managers guiding Claude, we must adhere to the following principles when integrating the vision component with the broader TTPRestream platform:
 
 1. **Trust the Engine's Output**: The vision engine has been rigorously tested against edge cases (custom sprites, aspect ratio stretching, compression artifacts). If the engine outputs data, the downstream systems (server `game_logic.py`, dashboard overlays) should trust it, rather than attempting to second-guess or re-filter the data.
 2. **Profile-Driven Configuration**: We must build the platform around the concept that every streamer *will* have unique visual quirks. The `crop_profiles` (stored in the database) are the primary configuration interface for the vision engine. Front-end tools should be built to make creating these landmarks and crop bounds as frictionless as possible for the race administrators.
 3. **Graceful Degradation**: The platform must handle `null` or missing vision data gracefully. If the vision engine cannot read a compressed stream or an occluded HUD, the overlays should not crash; they should simply maintain the last known good state until confidence is restored.
 
 ---

## 🟢 Highly Reliable (Fully Automated)

These capabilities function robustly on standard vanilla Randomizer streams without any manual intervention, provided the stream is reasonably clear (minimal compression artifacts).

### 1. Game State and Screen Classification
The engine can instantly identify the current state of the game screen using brightness heuristics and color analysis (bypassing the need for rigid template matching):
- **Overworld, Dungeon, Cave**: Automatically distinguished by average game area brightness.
- **Subscreen**: Accurately detected to trigger inventory reads.
- **Title Screen / Death / Transitions**: Correctly classified to avoid false-positive processing during non-gameplay moments.

### 2. Standard HUD Reading (Vanilla 8x8 Grid)
For standard 4:3 / 8:7 aspect ratio NES captures where the `-LIFE-` text lands cleanly on the row grid:
- **Counters**: Rupees, Keys, and Bombs are read perfectly across 1- or 2-digit counts.
- **Master Key ('A')**: Automatically detects the presence of the Master Key when the key count is replaced by the 'A' character.
- **Dungeon Level**: Read accurately from the `LEVEL-X` position during dungeon gameplay.
- **Sword & B-Item**: Correctly detects the Wooden, White, and Magical sword, and differentiates between visually similar items (e.g., Wand vs. Recorder) using specific color heuristics and twin-disambiguation logic.
- **Minimap**: Tracks Link's precise room within the dungeon map.
- **Ganon Room**: Swaps to looking for `-ROAR-` instead of `-LIFE-`.

### 3. In-Game Area Detection
- **Dropped Items / Triforce Pieces**: The `ItemDetector` scans the active gameplay area (below the HUD) specifically to detect **Triforce pieces** (indicated by orange blobs). Heart containers, keys, and other dropped items are currently not scanned. This acts as the primary trigger for the `validate()` game logic state machines to track "item holds" and "dungeon exits".

### 4. Subscreen Parsing (Inventory)
When the player pauses:
- **Inventory Matrix**: Does *not* read the Z1R inventory matrix. The engine currently falls back to relying purely on HUD B-item and Sword changes during gameplay. (Subscreen B-item parsing also relies solely on color heuristics, not templates, and only distinguishes candle/boomerang/recorder).
- **Triforce Pieces**: Accurately counts how many pieces of the Triforce have been collected by counting X-axis clusters on the subscreen layout, rather than sliding piece-by-piece.

---

## 🟡 Reliable with Assistance (Crop Profiles & Landmarks)

Streamers have incredibly unique setups—custom OBS layouts, custom Z1R sprite palettes, and heavily distorted aspect ratios. The engine can handle these perfectly, **BUT it requires a configured Crop Profile in the database/JSON**.

### 1. Distorted Aspect Ratios (e.g., Squished/Stretched Streams)
- **What it can do**: If the player stretches their 4:3 NES capture horizontally to fit a 16:9 layout, the rigid 8x8 pixel math completely fails.
- **How it works**: By defining explicit pixel boundaries (`[x, y, w, h]`) in the `"landmarks"` section of their crop profile, the engine entirely bypasses grid math. It extracts the raw squished pixels and normalizes them against the templates flawlessly.

### 2. Custom ROM Palettes (Blue Digits, Pink Hearts)
- **What it can do**: The engine is no longer rigidly locked to "white" digits or "pure red" hearts.
- **How it works**:
  - **Blue Digits**: The binary shape matcher uses max-channel preprocessing, meaning bright blue, bright green, or bright white digits all pass the threshold checks seamlessly.
  - **Non-Red Hearts**: By using a sophisticated `_sat_ratio` check, the engine identifies "warm" colors (red, orange, pink). **Note**: This capability currently requires a configured `Hearts` landmark in the crop profile to trigger.

### 3. Misaligned HUD Layouts
- **What it can do**: If a stream places their HUD slightly lower or higher on the screen due to cropped overscan areas.
- **How it works**: The `find_grid_alignment()` function scans for the `-LIFE-` text's red pixels to automatically calculate the `grid_dy` (Y-axis offset). For extreme layouts, explicitly defining the `landmarks` forces the engine to read the exact correct pixels regardless of where the stream placed the HUD.

---

## 🔴 Known Limitations & Hard Failures

These are areas where the vision engine will completely fail or return garbage data, requiring either human intervention or future architectural overhauls.

### 1. Extreme Video Compression (JPEG/Twitch Artifacting)
- **The Issue**: Template matching (`cv2.matchTemplate`) relies on binary pixel matrices. If a VOD or stream is heavily compressed, the hard edges of the 8x8 NES sprites turn into blurry, noisy gradients.
- **The Result**: Digits will misread (e.g., a compressed '8' might read as a '3' or '0'), and items will fail to cross the `0.3` confidence threshold.
- **The Mitigation**: The engine uses mathematical resizing (`INTER_AREA` and `INTER_NEAREST`) to preserve pixel edges, but extremely low-bitrate streams cannot be saved by code.

### 2. Custom Sprites with Drastically Different Shapes
- **The Issue**: Max-channel preprocessing allows us to read custom *colors*, but we cannot read custom *shapes*.
- **The Result**: If a streamer uses a custom ROM where the rupee icon is a completely different sprite (e.g., a coin or a rubber duck), the engine's built-in `templates/items/rupee.png` has a 0% chance of matching it.
- **The Mitigation**: The `BinaryShapeMatcher` (from Phase 5) is extremely modular. Supporting entirely custom sprite packs would require generating new sets of 8x8 `.png` templates and mapping them dynamically per-racer.

### 3. Ganon's Room "Darkness" State
- **The Issue**: The screen classifier relies heavily on average brightness to determine if a room is an `overworld`, `dungeon`, or `cave`.
- **The Result**: Rooms with custom palettes or extreme darkness (like Ganon's final room) can sometimes dip below the brightness threshold, confusing the classifier into thinking it's a cave or non-gameplay frame.
- **The Mitigation**: The engine has fallback logic indicating `if dungeon_level > 0 -> force dungeon screen_type`, but extreme graphical edge cases can still slip through.

### 4. Overlapped / Occluded Elements
- **The Issue**: Streamers occasionally place transparent chat boxes, webcam overlays, or speedrun timers directly on top of the Z1R HUD.
- **The Result**: The pixels are blended, destroying the template matching confidence score. The engine perceives the element as "absent" or "0".
- **The Mitigation**: None. The streamer must move the overlay off the gameplay capture.
