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

  it('auto-finalizes on handleVodEnded', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    await session.start({ racerId: 'test', vodUrl: 'https://twitch.tv/videos/123', playbackRate: 2 });

    session.feedEvents([
      { type: 'death', racerId: 'analyzer-test', timestamp: 500, frameNumber: 15, priority: 'high', description: 'Player died' },
    ]);
    session.feedState({ screenType: 'overworld', dungeonLevel: 0, rupees: 10, keys: 0, bombs: 0, heartsCurrentStable: 3, heartsMaxStable: 3, bItem: null, swordLevel: 0, hasMasterKey: false, mapPosition: 0, floorItems: [], triforceCollected: 0 }, {}, 5.0);

    await session.handleVodEnded();
    expect(session.getStatus().state).toBe('completed');
    expect(session.getResult()).not.toBeNull();
    expect(session.getResult()!.events).toHaveLength(1);
    expect(mgr.removeRacer).toHaveBeenCalledWith('analyzer-test');
    expect(ctrl.removeRacer).toHaveBeenCalledWith('analyzer-test');
  });

  it('fires onComplete callback when session finalizes', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    const onComplete = vi.fn();
    session.onComplete(onComplete);

    await session.start({ racerId: 'test', vodUrl: 'https://twitch.tv/videos/123', playbackRate: 2 });
    await session.stop();

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete.mock.calls[0][0].racerId).toBe('test');
    expect(onComplete.mock.calls[0][0].vodUrl).toBe('https://twitch.tv/videos/123');
  });

  it('fires onProgress callback periodically', async () => {
    const mgr = mockManager();
    const ctrl = mockController();
    const session = new RaceAnalyzerSession(mgr as any, ctrl as any);
    const onProgress = vi.fn();
    session.onProgress(onProgress);

    await session.start({ racerId: 'test', vodUrl: 'https://twitch.tv/videos/123', playbackRate: 2 });

    const baseState = { screenType: 'overworld' as const, dungeonLevel: 0, rupees: 0, keys: 0, bombs: 0, heartsCurrentStable: 3, heartsMaxStable: 3, bItem: null, swordLevel: 0, hasMasterKey: false, mapPosition: 0, floorItems: [] as any[], triforceCollected: 0 };

    // Feed 60 frames (progress fires every 60 frames)
    for (let i = 0; i < 60; i++) {
      session.feedState(baseState, {}, i * 0.5);
    }

    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress.mock.calls[0][0].frameCount).toBe(60);
  });

  it('ignores events and state when not running', () => {
    const session = new RaceAnalyzerSession(mockManager() as any, mockController() as any);
    // Should not throw
    session.feedEvents([{ type: 'death', racerId: 'x', timestamp: 0, frameNumber: 0, priority: 'high', description: '' }]);
    session.feedState({ screenType: 'overworld', dungeonLevel: 0, rupees: 0, keys: 0, bombs: 0, heartsCurrentStable: 3, heartsMaxStable: 3, bItem: null, swordLevel: 0, hasMasterKey: false, mapPosition: 0, floorItems: [], triforceCollected: 0 }, {}, 0);
    expect(session.getStatus().eventsFound).toBe(0);
  });
});
