export interface CalibrationUniform {
  scale_x: number; scale_y: number;
  offset_x: number; offset_y: number;
  video_w: number; video_h: number;
}

export class MinimapReader {
  private static readonly CONFIDENCE_THRESHOLD = 0.5;

  /** Interpret 128 room Pearson correlation scores from GPU readback. */
  interpretRoomScores(
    scores: number[],
    screenType: string,
    dungeonLevel: number,
    calib: CalibrationUniform,
  ): { mapPosition: number; confidence: number; tileMatchId: number | null } {
    if (!['overworld', 'dungeon', 'cave'].includes(screenType)) {
      return { mapPosition: 0, confidence: 0, tileMatchId: null };
    }

    let best = -1;
    let bestScore = -Infinity;
    scores.forEach((s, i) => {
      if (s > bestScore) { bestScore = s; best = i; }
    });

    if (bestScore < MinimapReader.CONFIDENCE_THRESHOLD) {
      return { mapPosition: 0, confidence: bestScore, tileMatchId: null };
    }

    const mapPosition = best; // 0-indexed: id = (row-1)*16 + (col-1)
    return { mapPosition, confidence: bestScore, tileMatchId: best };
  }
}
