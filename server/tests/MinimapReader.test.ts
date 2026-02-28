import { describe, it, expect } from 'vitest';
import { MinimapReader } from '../src/vision/MinimapReader';

describe('MinimapReader.interpretRoomScores', () => {
  const reader = new MinimapReader();

  it('returns best room index when score is high enough', () => {
    const scores = new Array(128).fill(0);
    scores[34] = 0.82; // room at index 34 (col 3, row 3)
    const result = reader.interpretRoomScores(scores, 'overworld', 0, {
      scale_x: 1, scale_y: 1, offset_x: 0, offset_y: 0, video_w: 256, video_h: 240,
    });
    expect(result.tileMatchId).toBe(34);
    expect(result.confidence).toBeCloseTo(0.82);
    expect(result.mapPosition).toBe(34);
  });

  it('returns null tileMatchId when best score is below threshold', () => {
    const scores = new Array(128).fill(0.2);
    const result = reader.interpretRoomScores(scores, 'overworld', 0, {
      scale_x: 1, scale_y: 1, offset_x: 0, offset_y: 0, video_w: 256, video_h: 240,
    });
    expect(result.tileMatchId).toBeNull();
    expect(result.mapPosition).toBe(0);
  });

  it('returns zeros for non-gameplay screens', () => {
    const scores = new Array(128).fill(0.9);
    const result = reader.interpretRoomScores(scores, 'subscreen', 0, {
      scale_x: 1, scale_y: 1, offset_x: 0, offset_y: 0, video_w: 256, video_h: 240,
    });
    expect(result.tileMatchId).toBeNull();
    expect(result.mapPosition).toBe(0);
    expect(result.confidence).toBe(0);
  });
});
