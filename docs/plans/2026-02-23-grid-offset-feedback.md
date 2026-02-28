# Grid Offset Feedback Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When vision_engine.py successfully calibrates grid_offset for a racer, write the confirmed values back to the crop profile in the DB so future sessions start with correct alignment.

**Architecture:** Pass `--crop-profile-id` from VisionBridge → vision_engine.py. In `run_diagnostics()` (fires on first gameplay frame), PUT the confirmed dx/dy back to `{server}/api/crop-profiles/{id}`. The existing PUT route already handles partial updates — no new route needed.

**Tech Stack:** Python (vision_engine.py), TypeScript (VisionBridge.ts, VisionManager.ts), Express PUT route already exists at `server/src/api/cropRoutes.ts:163`

---

### Task 1: Add `--crop-profile-id` to vision_engine.py and POST calibration back

**Files:**
- Modify: `vision/vision_engine.py`

**Step 1: Add the argument**

In `parse_args()`, after the `--landmarks` argument (line ~48):

```python
parser.add_argument('--crop-profile-id', default=None,
                    help='Crop profile ID — calibrated grid offset is written back to server')
```

**Step 2: POST calibrated values inside run_diagnostics()**

In `run_diagnostics()`, after the existing `cv2.imwrite(frame_path, frame)` line (line ~238), add:

```python
# Write calibrated grid offset back to crop profile
if args.crop_profile_id and args.server:
    try:
        requests.put(
            f'{args.server}/api/crop-profiles/{args.crop_profile_id}',
            json={'grid_offset_dx': dx, 'grid_offset_dy': dy},
            timeout=2,
        )
        print(f'[Vision][Diag] Updated crop profile {args.crop_profile_id[:8]} '
              f'grid_offset dx={dx} dy={dy}', file=sys.stderr)
    except requests.RequestException as e:
        print(f'[Vision][Diag] Failed to update crop profile: {e}', file=sys.stderr)
```

Note: `requests` is already imported. `dx`, `dy` are already defined earlier in `run_diagnostics()` as `hud.grid_dx`, `hud.grid_dy`. This fires at most once per session (guarded by `diag_done`).

**Step 3: Verify manually**

```bash
# Confirm --crop-profile-id appears in help
cd vision && .venv/Scripts/python vision_engine.py --help | grep crop-profile-id
```

Expected: `--crop-profile-id CROP_PROFILE_ID`

**Step 4: Commit**

```bash
git add vision/vision_engine.py
git commit -m "feat: write calibrated grid_offset back to crop profile via server API"
```

---

### Task 2: Thread cropProfileId through VisionBridgeOptions → VisionBridge.ts

**Files:**
- Modify: `server/src/vision/VisionBridge.ts`

**Step 1: Add to interface**

In `VisionBridgeOptions` interface (around line 14-21), add:

```typescript
cropProfileId?: string;
```

**Step 2: Pass to python args**

In the `pythonArgs` array construction (after the `--landmarks` block, around line 97-99):

```typescript
if (this.options.cropProfileId) {
  pythonArgs.push('--crop-profile-id', this.options.cropProfileId);
}
```

**Step 3: Verify TypeScript compiles**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors

**Step 4: Commit**

```bash
git add server/src/vision/VisionBridge.ts
git commit -m "feat: pass crop-profile-id to vision_engine when available"
```

---

### Task 3: Pass cropProfileId from VisionManager into VisionBridgeOptions

**Files:**
- Modify: `server/src/vision/VisionManager.ts`

**Step 1: Include cropProfileId in options**

In `startVision()`, in the `options: VisionBridgeOptions` object (after `gridOffsetDy`, around line 47):

```typescript
cropProfileId: cropData.cropProfileId ?? undefined,
```

`cropData.cropProfileId` is already a `string | null` on `CropData` (see `CropProfileService.ts:15`). The `?? undefined` converts `null` to `undefined` to satisfy the optional field type.

**Step 2: Verify TypeScript compiles**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors

**Step 3: Build and restart server**

```bash
cd server && npx tsc && node dist/index.js
```

**Step 4: Commit**

```bash
git add server/src/vision/VisionManager.ts
git commit -m "feat: thread cropProfileId through to VisionBridge for grid offset feedback"
```

---

### Task 4: Manual end-to-end smoke test

**Goal:** Confirm that when a racer goes live, the DB grid_offset is updated after the first gameplay frame.

**Steps:**

1. Set a racer's crop profile `grid_offset_dy` to 0 in the DB to simulate a stale value:
   ```sql
   UPDATE crop_profiles SET grid_offset_dy = 0 WHERE id = '<known-id>';
   ```

2. Start the server and trigger live vision for that racer via the dashboard.

3. Watch server logs for:
   ```
   [Vision][Diag] Updated crop profile <id> grid_offset dx=0 dy=6
   ```

4. Confirm DB was updated:
   ```sql
   SELECT grid_offset_dx, grid_offset_dy FROM crop_profiles WHERE id = '<known-id>';
   ```
   Expected: `dy = 6` (or correct value for that racer).

5. Stop vision. Repeat: the value should already be correct, so the second run's diag should confirm the same value.
