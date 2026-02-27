interface NesCounterProps {
  value: number;
  icon?: 'rupee' | 'key' | 'bomb';
  label?: string;
}

const ICONS: Record<string, string> = {
  rupee: '💎',
  key: '🔑',
  bomb: '💣',
};

export function NesCounter({ value, icon, label }: NesCounterProps) {
  return (
    <span className="inline-flex items-center gap-1 font-pixel text-[10px] leading-none"
      style={{ color: 'var(--text-primary)' }}>
      {icon && <span className="text-xs">{ICONS[icon]}</span>}
      {label && <span style={{ color: 'var(--text-muted)' }}>{label}</span>}
      <span>×{String(value).padStart(2, '0')}</span>
    </span>
  );
}
