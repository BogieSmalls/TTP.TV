import { useState } from 'react';
import { useSocketEvent } from '../../hooks/useSocket.js';

interface GameEvent {
  type: string;
  description?: string;
}

interface FlatEvent {
  id: number;
  racerId: string;
  type: string;
  description: string;
  timestamp: number;
}

const HIGH_EVENTS = new Set(['triforce_inferred', 'death', 'game_complete', 'ganon_fight', 'ganon_kill']);
const MEDIUM_EVENTS = new Set(['heart_container', 'dungeon_first_visit', 'sword_upgrade', 'staircase_item_acquired']);

function eventColor(type: string): string {
  if (HIGH_EVENTS.has(type)) return 'text-red-400';
  if (MEDIUM_EVENTS.has(type)) return 'text-yellow-400';
  return 'text-gray-400';
}

let idCounter = 0;

interface Props {
  racerId: string | null;
}

export function WebGPUEventLog({ racerId }: Props) {
  const [events, setEvents] = useState<FlatEvent[]>([]);

  useSocketEvent<{ racerId: string; events: GameEvent[] }>('vision:events', (data) => {
    if (data.racerId !== racerId) return;
    const flat = data.events.map(e => ({
      id: ++idCounter,
      racerId: data.racerId,
      type: e.type,
      description: e.description ?? '',
      timestamp: Date.now(),
    }));
    setEvents(prev => [...flat, ...prev].slice(0, 100));
  });

  return (
    <div className="h-full overflow-y-auto text-xs font-mono space-y-1">
      {events.length === 0 && (
        <div className="text-gray-500">No events yet</div>
      )}
      {events.map(e => (
        <div key={e.id} className="flex gap-2">
          <span className="text-gray-500 shrink-0">
            {new Date(e.timestamp).toLocaleTimeString()}
          </span>
          <span className={`font-semibold shrink-0 ${eventColor(e.type)}`}>{e.type}</span>
          {e.description && <span className="text-gray-400 truncate">{e.description}</span>}
        </div>
      ))}
    </div>
  );
}
