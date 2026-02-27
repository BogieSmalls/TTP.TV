interface TriforceTrackerProps {
  collected: number;
}

export function TriforceTracker({ collected }: TriforceTrackerProps) {
  return (
    <span className="inline-flex gap-1">
      {Array.from({ length: 8 }, (_, i) => (
        <svg key={i} width="12" height="11" viewBox="0 0 12 11">
          <polygon
            points="6,0 12,11 0,11"
            fill={i < collected ? 'var(--accent)' : 'none'}
            stroke={i < collected ? 'var(--accent)' : 'var(--text-muted)'}
            strokeWidth="1"
            opacity={i < collected ? 1 : 0.3}
          />
        </svg>
      ))}
    </span>
  );
}
