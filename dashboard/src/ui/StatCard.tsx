import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  icon: ReactNode;
  status?: 'ok' | 'warn' | 'error';
  onClick?: () => void;
  action?: ReactNode;
}

const statusColors: Record<string, { color: string; glow: string }> = {
  ok: { color: 'var(--success)', glow: 'var(--shadow-glow-success)' },
  warn: { color: 'var(--warning)', glow: 'var(--shadow-glow-warning)' },
  error: { color: 'var(--danger)', glow: 'var(--shadow-glow-danger)' },
};

export function StatCard({ label, value, icon, status, onClick, action }: StatCardProps) {
  const s = status ? statusColors[status] : null;
  return (
    <div
      className={`group rounded-lg border p-4 transition-all duration-150 ${onClick ? 'cursor-pointer' : ''}`}
      style={{
        background: 'var(--bg-surface)',
        borderColor: 'var(--border)',
        boxShadow: 'var(--shadow-sm)',
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        if (s) (e.currentTarget as HTMLDivElement).style.boxShadow = s.glow;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-sm)';
      }}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg flex-shrink-0"
          style={{
            background: s ? `${s.color}15` : 'var(--accent-subtle)',
            color: s ? s.color : 'var(--accent)',
          }}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            {label}
          </p>
          <p className="text-lg font-bold tabular-nums truncate" style={{ color: 'var(--text-primary)' }}>
            {value}
          </p>
        </div>
      </div>
      {action && <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>{action}</div>}
    </div>
  );
}
