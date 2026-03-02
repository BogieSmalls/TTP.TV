import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaceAnalyzerSession } from '../src/vision/RaceAnalyzerSession.js';

// Mock VisionWorkerManager
function mockManager() {
  return {
    addRacer: vi.fn().mockResolvedValue(undefined),
    removeRacer: vi.fn().mockResolvedValue(undefined),
    setPlaybackRate: vi.fn(),
    onVodEnded: vi.fn(),
    getActiveRacerIds: vi.fn().mockReturnValue([]),
  };
}

// Mock VisionPipelineController
function mockController() {
  return {
    addRacer: vi.fn(),
    removeRacer: vi.fn(),
    onStateUpdate: vi.fn(),
    onGameEvents: vi.fn(),
  };
}

describe('RaceAnalyzerSession', () => {
  it('starts in idle state', () => {
    const session = new RaceAnalyzerSession(mockManager() as any, mockController() as any);
    expect(session.getStatus().state).toBe('idle');
  });

  it('transitions to running on start', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    await session.start({
      racerId: 'test',
      vodUrl: 'https://twitch.tv/videos/123',
      playbackRate: 2,
    });
    expect(session.getStatus().state).toBe('running');
    expect(mgr.addRacer).toHaveBeenCalledOnce();
    expect(ctrl.addRacer).toHaveBeenCalledWith('analyzer-test');
  });

  it('records events fed to it', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    await session.start({ racerId: 'test', vodUrl: 'https://twitch.tv/videos/123', playbackRate: 2 });

    session.feedEvents([
      { type: 'death', racerId: 'analyzer-test', timestamp: 1000, frameNumber: 30, priority: 'high', description: 'Player died' },
    ]);
    session.feedState({ screenType: 'overworld', dungeonLevel: 0, rupees: 50, keys: 0, bombs: 3, heartsCurrentStable: 3, heartsMaxStable: 3, bItem: null, swordLevel: 1, hasMasterKey: false, mapPosition: 5, floorItems: [], triforceCollected: 0 }, {}, 10.5);

    const status = session.getStatus();
    expect(status.eventsFound).toBe(1);
  });

  it('produces result on stop', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    await session.start({ racerId: 'test', vodUrl: 'https://twitch.tv/videos/123', playbackRate: 2 });

    session.feedEvents([
      { type: 'death', racerId: 'analyzer-test', timestamp: 1000, frameNumber: 30, priority: 'high', description: 'Player died' },
    ]);

    const result = await session.stop();
    expect(result).not.toBeNull();
    expect(result!.events).toHaveLength(1);
    expect(result!.summary.deaths).toBe(1);
    expect(session.getStatus().state).toBe('completed');
  });
});
