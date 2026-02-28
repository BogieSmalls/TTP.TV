interface TrackedItem {
  name: string;
  x: number;
  y: number;
  score: number;
  confirmedFrames: number;
  goneFrames: number;
}

export class FloorItemTracker {
  private items = new Map<string, TrackedItem>();
  private readonly CONFIRM_FRAMES = 3;
  private readonly GONE_FRAMES = 6;
  private readonly GRACE_FRAMES = 3;
  private graceFramesLeft = 0;

  onRoomChange(): void {
    this.graceFramesLeft = this.GRACE_FRAMES;
    this.items.clear();
  }

  update(rawItems: Array<{ name: string; x: number; y: number; score: number }>):
    { confirmed: Array<{ name: string; x: number; y: number; score: number }>;
      obtained: Array<{ name: string; x: number; y: number; score: number }> } {
    if (this.graceFramesLeft > 0) {
      this.graceFramesLeft--;
      return { confirmed: [], obtained: [] };
    }

    const seen = new Set<string>();
    for (const raw of rawItems) {
      const key = `${raw.name}@${Math.round(raw.x / 8)}x${Math.round(raw.y / 8)}`;
      seen.add(key);
      const existing = this.items.get(key);
      if (existing) {
        existing.confirmedFrames++;
        existing.goneFrames = 0;
      } else {
        this.items.set(key, { ...raw, confirmedFrames: 1, goneFrames: 0 });
      }
    }

    const confirmed: Array<{ name: string; x: number; y: number; score: number }> = [];
    const obtained: Array<{ name: string; x: number; y: number; score: number }> = [];

    for (const [key, tracked] of this.items) {
      if (!seen.has(key)) {
        tracked.goneFrames++;
        if (tracked.goneFrames >= this.GONE_FRAMES && tracked.confirmedFrames >= this.CONFIRM_FRAMES) {
          obtained.push({ name: tracked.name, x: tracked.x, y: tracked.y, score: tracked.score });
          this.items.delete(key);
        }
      } else if (tracked.confirmedFrames >= this.CONFIRM_FRAMES) {
        confirmed.push({ name: tracked.name, x: tracked.x, y: tracked.y, score: tracked.score });
      }
    }

    return { confirmed, obtained };
  }
}
