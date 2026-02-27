import { Radio, StopCircle, RotateCcw } from 'lucide-react';
import type { StreamStatus } from '../lib/api';

interface Props {
  status: StreamStatus;
  onStop: () => void;
}

const stateColors: Record<string, string> = {
  running: 'text-success',
  starting: 'text-warning',
  error: 'text-danger',
  stopped: 'text-white/40',
};

export default function StreamCard({ status, onStop }: Props) {
  return (
    <div className="bg-panel-light rounded-lg p-4 border border-white/5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Radio size={16} className={stateColors[status.state] || 'text-white/40'} />
          <span className="font-medium text-sm">{status.twitchChannel}</span>
        </div>
        <span className={`text-xs font-medium ${stateColors[status.state]}`}>
          {status.state}
        </span>
      </div>

      <div className="text-xs text-white/40 space-y-1">
        <div>Key: {status.streamKey}</div>
        {status.startedAt && (
          <div>Started: {new Date(status.startedAt).toLocaleTimeString()}</div>
        )}
        {status.restartCount > 0 && (
          <div className="flex items-center gap-1 text-warning">
            <RotateCcw size={12} />
            Restarts: {status.restartCount}
          </div>
        )}
        {status.error && (
          <div className="text-danger mt-1">{status.error}</div>
        )}
      </div>

      {status.state !== 'stopped' && (
        <button
          onClick={onStop}
          className="mt-3 flex items-center gap-1.5 text-xs text-danger/80 hover:text-danger transition-colors"
        >
          <StopCircle size={14} />
          Stop
        </button>
      )}
    </div>
  );
}
