import { useEffect, useCallback } from 'react';
import type { LearnSnapshot } from '../../lib/learnApi';

interface TimelineNavigationOpts {
  snapshots: LearnSnapshot[];
  currentIndex: number;
  setCurrentIndex: (i: number) => void;
  isPlaying: boolean;
  setIsPlaying: (p: boolean) => void;
  onAnnotate?: () => void;
}

export function useTimelineNavigation(opts: TimelineNavigationOpts) {
  const { snapshots, currentIndex, setCurrentIndex, isPlaying, setIsPlaying, onAnnotate } = opts;
  const count = snapshots.length;

  const jumpToNextTransition = useCallback((direction: 1 | -1) => {
    let i = currentIndex + direction;
    while (i >= 0 && i < count) {
      if (snapshots[i].reason === 'transition') {
        setCurrentIndex(i);
        return;
      }
      i += direction;
    }
  }, [currentIndex, count, snapshots, setCurrentIndex]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case 'ArrowRight':
        case 'l':
          e.preventDefault();
          setCurrentIndex(Math.min(currentIndex + 1, count - 1));
          break;
        case 'ArrowLeft':
        case 'j':
          e.preventDefault();
          setCurrentIndex(Math.max(currentIndex - 1, 0));
          break;
        case ' ':
          e.preventDefault();
          setIsPlaying(!isPlaying);
          break;
        case 'Home':
          e.preventDefault();
          setCurrentIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setCurrentIndex(count - 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          jumpToNextTransition(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          jumpToNextTransition(1);
          break;
        case 'a':
          e.preventDefault();
          onAnnotate?.();
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, count, isPlaying, setCurrentIndex, setIsPlaying, jumpToNextTransition, onAnnotate]);
}

export function findNearestSnapshotIndex(snapshots: LearnSnapshot[], targetTime: number): number {
  if (snapshots.length === 0) return 0;
  let lo = 0, hi = snapshots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].videoTimestamp < targetTime) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(snapshots[lo - 1].videoTimestamp - targetTime) < Math.abs(snapshots[lo].videoTimestamp - targetTime)) {
    return lo - 1;
  }
  return lo;
}
