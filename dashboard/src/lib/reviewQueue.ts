import type { LearnSnapshot, LearnReport } from './learnApi';

export type ReviewCategory = 'map_position' | 'items' | 'b_item' | 'screen_type';

export interface ReviewItem {
  index: number;                    // index into snapshots[]
  snapshot: LearnSnapshot;
  prevSnapshot: LearnSnapshot | null;
  nextSnapshot: LearnSnapshot | null;  // next gameplay snapshot (for transition context)
  context: string[];                // bullet points of factual context
  interpretation: string;           // assessment of correctness
  confidence: 'high' | 'medium' | 'low';
  field: string;                    // detector field name for corrections
  detectedValue: string;            // what was detected (for correction annotation)
}

// ─── Grid helpers ───

const OVERWORLD_COLS = 16;
const DUNGEON_COLS = 8;

export function gridColsForScreen(screenType: string): number {
  return screenType === 'dungeon' ? DUNGEON_COLS : OVERWORLD_COLS;
}

export function positionToGrid(pos: number, cols: number): { row: number; col: number } {
  return { row: Math.floor(pos / cols), col: pos % cols };
}

export function positionLabel(pos: number, cols: number): string {
  const { row, col } = positionToGrid(pos, cols);
  return `C${col + 1},R${row + 1}`;
}

function directionLabel(prevPos: number, currPos: number, cols: number): string {
  const prev = positionToGrid(prevPos, cols);
  const curr = positionToGrid(currPos, cols);
  const dr = curr.row - prev.row;
  const dc = curr.col - prev.col;
  if (dr === 0 && dc === 1) return 'East';
  if (dr === 0 && dc === -1) return 'West';
  if (dr === 1 && dc === 0) return 'South';
  if (dr === -1 && dc === 0) return 'North';
  if (dr === 0 && dc === 0) return 'same room';
  const dist = Math.abs(dr) + Math.abs(dc);
  return `non-adjacent (${dist} rooms)`;
}

function isAdjacent(pos1: number, pos2: number, cols: number): boolean {
  if (pos1 === pos2) return true;
  const r1 = Math.floor(pos1 / cols), c1 = pos1 % cols;
  const r2 = Math.floor(pos2 / cols), c2 = pos2 % cols;
  return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
}

// ─── Per-category interpretation ───

interface MapContext {
  owStartScreen: number;    // First overworld position (Up+A always warps here)
  dgEntrance: number;       // Current dungeon entrance (first room entered this visit)
  recentScreens: string[];  // Last few screen types before this snapshot (for warp detection)
}

function interpretMapPosition(
  snap: LearnSnapshot,
  prev: LearnSnapshot | null,
  mapCtx: MapContext,
): Pick<ReviewItem, 'context' | 'interpretation' | 'confidence'> {
  const cols = gridColsForScreen(snap.screenType);
  const context: string[] = [
    `Screen: ${snap.screenType}`,
    `Position: ${positionLabel(snap.mapPosition, cols)} (room ${snap.mapPosition})`,
  ];

  if (prev && prev.mapPosition > 0) {
    const prevCols = gridColsForScreen(prev.screenType);
    context.push(`Previous: ${positionLabel(prev.mapPosition, prevCols)} (room ${prev.mapPosition})`);

    // Don't compare positions across different grid types
    if (prev.screenType !== snap.screenType) {
      context.push('Grid changed (different screen type)');
      return {
        context,
        interpretation: `Screen type changed from ${prev.screenType} to ${snap.screenType}. Position grids are different — not comparable.`,
        confidence: 'medium',
      };
    }

    const dir = directionLabel(prev.mapPosition, snap.mapPosition, cols);
    context.push(`Direction: ${dir}`);
    const adj = isAdjacent(prev.mapPosition, snap.mapPosition, cols);
    context.push(`Adjacent: ${adj ? 'yes' : 'NO'}`);

    if (!adj) {
      // Check for telltale signs in recent screen history
      const hadSubscreen = mapCtx.recentScreens.includes('subscreen');
      const hadTitle = mapCtx.recentScreens.includes('title');

      // ─── Overworld non-adjacent ───
      if (snap.screenType === 'overworld') {
        if (mapCtx.owStartScreen > 0 && snap.mapPosition === mapCtx.owStartScreen) {
          const method = hadTitle ? 'Reset' : hadSubscreen ? 'Up+A' : 'Up+A / Reset';
          context.push(`Start screen: ${positionLabel(mapCtx.owStartScreen, cols)}`);
          if (hadTitle) context.push('Title screen seen before warp → Reset');
          if (hadSubscreen && !hadTitle) context.push('Subscreen seen before warp → Up+A');
          return {
            context,
            interpretation: `${method} — warped from ${positionLabel(prev.mapPosition, cols)} back to start screen ${positionLabel(snap.mapPosition, cols)}.`,
            confidence: 'high',
          };
        }
        return {
          context,
          interpretation: `Non-adjacent overworld jump from ${positionLabel(prev.mapPosition, cols)} to ${positionLabel(snap.mapPosition, cols)}. Could be cave/warp exit or detection error.`,
          confidence: 'low',
        };
      }

      // ─── Dungeon non-adjacent ───
      if (snap.screenType === 'dungeon') {
        if (mapCtx.dgEntrance > 0 && snap.mapPosition === mapCtx.dgEntrance) {
          context.push(`Dungeon entrance: ${positionLabel(mapCtx.dgEntrance, cols)}`);
          if (hadSubscreen) context.push('Subscreen seen before warp → Up+A');
          return {
            context,
            interpretation: `Up+A — warped from ${positionLabel(prev.mapPosition, cols)} back to dungeon entrance ${positionLabel(snap.mapPosition, cols)}.`,
            confidence: 'high',
          };
        }
        return {
          context,
          interpretation: `Non-adjacent dungeon move from ${positionLabel(prev.mapPosition, cols)} to ${positionLabel(snap.mapPosition, cols)}. Likely staircase warp.`,
          confidence: 'medium',
        };
      }
    }
    if (dir === 'same room') {
      return {
        context,
        interpretation: 'Same room as previous snapshot. Position stable.',
        confidence: 'high',
      };
    }
    return {
      context,
      interpretation: `Moved ${dir}. Normal navigation.`,
      confidence: 'high',
    };
  }

  // Previous position was 0 (no dot detected) — staircase exit or first reading
  if (prev && prev.mapPosition === 0) {
    context.push('Previous: no position (room 0)');
    if (snap.screenType === 'dungeon') {
      return {
        context,
        interpretation: 'Position appeared after map marker was absent. Likely staircase exit or room entry.',
        confidence: 'medium',
      };
    }
  }

  return {
    context,
    interpretation: 'First position reading or no previous to compare.',
    confidence: 'medium',
  };
}

function interpretItems(snap: LearnSnapshot, prev: LearnSnapshot | null): Pick<ReviewItem, 'context' | 'interpretation' | 'confidence'> {
  const context: string[] = [
    `Screen: ${snap.screenType}`,
    `Snapshot: ${snap.filename}`,
  ];

  // Note: snapshot metadata doesn't carry the full items dict currently.
  // We show what we can from the available fields.
  if (snap.hasMasterKey) context.push('Master Key: yes');
  if (snap.swordLevel > 0) context.push(`Sword: level ${snap.swordLevel}`);
  if (snap.bItem) context.push(`B-Item: ${snap.bItem}`);

  if (prev && prev.screenType === 'subscreen') {
    const changes: string[] = [];
    if (snap.hasMasterKey !== prev.hasMasterKey) changes.push(`Master Key: ${prev.hasMasterKey} → ${snap.hasMasterKey}`);
    if (snap.swordLevel !== prev.swordLevel) changes.push(`Sword: ${prev.swordLevel} → ${snap.swordLevel}`);
    if (snap.bItem !== prev.bItem) changes.push(`B-Item: ${prev.bItem || 'none'} → ${snap.bItem || 'none'}`);
    if (changes.length > 0) {
      context.push(`Changes from prev subscreen: ${changes.join(', ')}`);
    }
  }

  return {
    context,
    interpretation: 'Subscreen snapshot — verify items visible on screen match detected state. Look for any items the detector may have missed or misidentified.',
    confidence: 'medium',
  };
}

function interpretBItem(snap: LearnSnapshot, prev: LearnSnapshot | null): Pick<ReviewItem, 'context' | 'interpretation' | 'confidence'> {
  const context: string[] = [
    `Screen: ${snap.screenType}`,
    `B-Item detected: ${snap.bItem || 'none'}`,
  ];

  if (prev) {
    context.push(`Previous B-Item: ${prev.bItem || 'none'}`);
    if (snap.bItem !== prev.bItem) {
      context.push(`Changed: ${prev.bItem || 'none'} → ${snap.bItem || 'none'}`);
    }
  }

  if (!snap.bItem || snap.bItem === 'unknown') {
    return {
      context,
      interpretation: snap.bItem === 'unknown'
        ? 'Color heuristic could not identify this item. Check the B-item slot in the HUD.'
        : 'No B-item detected. Verify the HUD B-item slot is empty.',
      confidence: 'low',
    };
  }

  return {
    context,
    interpretation: `Detected "${snap.bItem}" from HUD color analysis. Verify against the B-item sprite visible in the top-left HUD area.`,
    confidence: 'medium',
  };
}

function interpretScreenType(snap: LearnSnapshot, prev: LearnSnapshot | null): Pick<ReviewItem, 'context' | 'interpretation' | 'confidence'> {
  const context: string[] = [
    `Screen type: ${snap.screenType}`,
    `Transition: ${snap.extra || 'n/a'}`,
  ];

  if (snap.dungeonLevel > 0) {
    context.push(`Dungeon level: ${snap.dungeonLevel}`);
  }
  if (prev) {
    context.push(`Previous: ${prev.screenType}`);
  }

  if (snap.screenType === 'unknown') {
    return {
      context,
      interpretation: 'Classifier could not determine screen type. Check if this is a loading screen, transition, or unusual game state.',
      confidence: 'low',
    };
  }

  if (snap.dungeonLevel > 0 && snap.screenType === 'overworld') {
    return {
      context,
      interpretation: 'Classified as overworld but dungeon level detected — possible bright dungeon misclassification.',
      confidence: 'low',
    };
  }

  return {
    context,
    interpretation: `Classified as "${snap.screenType}". Verify this matches what you see on screen.`,
    confidence: 'high',
  };
}

// ─── Queue generation ───

export function generateQueue(
  snapshots: LearnSnapshot[],
  category: ReviewCategory,
  anomalies?: LearnReport['anomalies'],
): ReviewItem[] {
  const items: ReviewItem[] = [];

  switch (category) {
    case 'map_position': {
      // Track start screen and dungeon entrances for warp detection
      const mapCtx: MapContext = { owStartScreen: 0, dgEntrance: 0, recentScreens: [] };
      let lastScreenType = '';
      let lastGameplay: LearnSnapshot | null = null;
      let lastGameplayIdx = -1;

      // Pre-build list of gameplay snapshots for lookforward context
      const gameplayIndices: number[] = [];
      for (let i = 0; i < snapshots.length; i++) {
        if (['overworld', 'dungeon'].includes(snapshots[i].screenType) && snapshots[i].mapPosition > 0) {
          gameplayIndices.push(i);
        }
      }

      for (let gi = 0; gi < gameplayIndices.length; gi++) {
        const i = gameplayIndices[gi];
        const snap = snapshots[i];

        // Track non-gameplay screens between gameplay snapshots for warp detection
        if (lastGameplayIdx >= 0) {
          for (let j = lastGameplayIdx + 1; j < i; j++) {
            if (snapshots[j].screenType !== 'unknown') {
              mapCtx.recentScreens.push(snapshots[j].screenType);
            }
          }
        }

        // Detect overworld start screen (first overworld position in the session)
        if (snap.screenType === 'overworld' && mapCtx.owStartScreen === 0) {
          mapCtx.owStartScreen = snap.mapPosition;
        }

        // Detect dungeon entrance (first dungeon position after entering from non-dungeon)
        if (snap.screenType === 'dungeon' && lastScreenType !== 'dungeon') {
          mapCtx.dgEntrance = snap.mapPosition;
        }
        lastScreenType = snap.screenType;

        // Skip consecutive same-position, same-screenType snapshots (only show changes)
        if (lastGameplay && lastGameplay.mapPosition === snap.mapPosition
            && lastGameplay.screenType === snap.screenType) {
          lastGameplay = snap;
          lastGameplayIdx = i;
          mapCtx.recentScreens = [];
          continue;
        }

        // Find next gameplay snapshot for context
        const nextGameplay = gi + 1 < gameplayIndices.length
          ? snapshots[gameplayIndices[gi + 1]]
          : null;

        const { context, interpretation, confidence } = interpretMapPosition(snap, lastGameplay, mapCtx);

        // Use positionConfidence from calibration if available (more authoritative)
        const finalConfidence = snap.positionConfidence || confidence;

        // Add extended context for low-confidence (transition) snapshots
        if (finalConfidence === 'low') {
          if (lastGameplay) {
            const prevCols = gridColsForScreen(lastGameplay.screenType);
            context.push(`Lookback: ${positionLabel(lastGameplay.mapPosition, prevCols)} [${lastGameplay.positionConfidence || '?'}]`);
          }
          if (nextGameplay) {
            const nextCols = gridColsForScreen(nextGameplay.screenType);
            context.push(`Lookforward: ${positionLabel(nextGameplay.mapPosition, nextCols)} [${nextGameplay.positionConfidence || '?'}]`);
          }
        }

        items.push({
          index: i,
          snapshot: snap,
          prevSnapshot: lastGameplay,
          nextSnapshot: nextGameplay,
          context,
          interpretation,
          confidence: finalConfidence,
          field: 'map_position',
          detectedValue: positionLabel(snap.mapPosition, gridColsForScreen(snap.screenType)),
        });
        lastGameplay = snap;
        lastGameplayIdx = i;
        mapCtx.recentScreens = [];
      }
      break;
    }

    case 'items': {
      // All subscreen snapshots
      let lastSubscreen: LearnSnapshot | null = null;
      for (let i = 0; i < snapshots.length; i++) {
        const snap = snapshots[i];
        if (snap.screenType !== 'subscreen') continue;
        const { context, interpretation, confidence } = interpretItems(snap, lastSubscreen);
        items.push({
          index: i,
          snapshot: snap,
          prevSnapshot: lastSubscreen,
          nextSnapshot: null,
          context,
          interpretation,
          confidence,
          field: 'items',
          detectedValue: 'subscreen',
        });
        lastSubscreen = snap;
      }
      break;
    }

    case 'b_item': {
      // Gameplay snapshots where B-item changed
      let lastBItem: string | null = null;
      let lastSnap: LearnSnapshot | null = null;
      for (let i = 0; i < snapshots.length; i++) {
        const snap = snapshots[i];
        if (!['overworld', 'dungeon', 'cave'].includes(snap.screenType)) continue;
        const bItem = snap.bItem || '';
        if (bItem === lastBItem) {
          lastSnap = snap;
          continue;
        }
        const { context, interpretation, confidence } = interpretBItem(snap, lastSnap);
        items.push({
          index: i,
          snapshot: snap,
          prevSnapshot: lastSnap,
          nextSnapshot: null,
          context,
          interpretation,
          confidence,
          field: 'b_item',
          detectedValue: snap.bItem || '',
        });
        lastBItem = bItem;
        lastSnap = snap;
      }
      break;
    }

    case 'screen_type': {
      // Transition snapshots
      for (let i = 0; i < snapshots.length; i++) {
        const snap = snapshots[i];
        if (snap.reason !== 'transition') continue;
        const prev = i > 0 ? snapshots[i - 1] : null;
        const { context, interpretation, confidence } = interpretScreenType(snap, prev);
        items.push({
          index: i,
          snapshot: snap,
          prevSnapshot: prev,
          nextSnapshot: null,
          context,
          interpretation,
          confidence,
          field: 'screen_type',
          detectedValue: snap.screenType,
        });
      }
      break;
    }
  }

  // Sort low-confidence items first so the most suspicious ones are reviewed first
  items.sort((a, b) => {
    const order = { low: 0, medium: 1, high: 2 };
    return order[a.confidence] - order[b.confidence];
  });

  return items;
}

export const CATEGORY_LABELS: Record<ReviewCategory, string> = {
  map_position: 'Map Position',
  items: 'Items (Subscreen)',
  b_item: 'B-Item',
  screen_type: 'Screen Type',
};
